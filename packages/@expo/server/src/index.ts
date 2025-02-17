import '@expo/server/install';

import { Response } from '@remix-run/node';
import type { ExpoRoutesManifestV1, RouteInfo } from 'expo-router/build/routes-manifest';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import { ExpoRequest, ExpoResponse, ExpoURL, NON_STANDARD_SYMBOL } from './environment';
import { ExpoRouterServerManifestV1FunctionRoute } from './types';

const debug = require('debug')('expo:server') as typeof console.log;

function getProcessedManifest(path: string): ExpoRoutesManifestV1<RegExp> {
  // TODO: JSON Schema for validation
  const routesManifest = JSON.parse(fs.readFileSync(path, 'utf-8')) as ExpoRoutesManifestV1;

  const parsed: ExpoRoutesManifestV1<RegExp> = {
    ...routesManifest,
    notFoundRoutes: routesManifest.notFoundRoutes.map((value: any) => {
      return {
        ...value,
        namedRegex: new RegExp(value.namedRegex),
      };
    }),
    apiRoutes: routesManifest.apiRoutes.map((value: any) => {
      return {
        ...value,
        namedRegex: new RegExp(value.namedRegex),
      };
    }),
    htmlRoutes: routesManifest.htmlRoutes.map((value: any) => {
      return {
        ...value,
        namedRegex: new RegExp(value.namedRegex),
      };
    }),
  };

  return parsed;
}

export function getRoutesManifest(distFolder: string) {
  return getProcessedManifest(path.join(distFolder, '_expo/routes.json'));
}

// TODO: Reuse this for dev as well
export function createRequestHandler(
  distFolder: string,
  {
    getRoutesManifest: getInternalRoutesManifest,
    getHtml = async (request, route) => {
      // serve a static file
      const filePath = path.join(distFolder, route.page + '.html');

      if (!fs.existsSync(filePath)) {
        return null;
      }
      return fs.readFileSync(filePath, 'utf-8');
    },
    getApiRoute = async (route) => {
      const filePath = path.join(distFolder, route.file);

      debug(`Handling API route: ${route.page}: ${filePath}`);

      // TODO: What's the standard behavior for malformed projects?
      if (!fs.existsSync(filePath)) {
        return null;
      }

      if (/\.[cj]s$/.test(filePath)) {
        return require(filePath);
      }
      return import(filePath);
    },
    logApiRouteExecutionError = (error: Error) => {
      console.error(error);
    },
  }: {
    getHtml?: (
      request: ExpoRequest,
      route: RouteInfo<RegExp>
    ) => Promise<string | ExpoResponse | null>;
    getRoutesManifest?: (distFolder: string) => Promise<ExpoRoutesManifestV1<RegExp> | null>;
    getApiRoute?: (route: RouteInfo<RegExp>) => Promise<any>;
    logApiRouteExecutionError?: (error: Error) => void;
  } = {}
) {
  let routesManifest: ExpoRoutesManifestV1<RegExp> | undefined;

  function updateRequestWithConfig(
    request: ExpoRequest,
    config: ExpoRouterServerManifestV1FunctionRoute
  ) {
    const params: Record<string, string> = {};
    const url = request.url;

    const expoUrl = new ExpoURL(url);
    const match = config.namedRegex.exec(expoUrl.pathname);
    if (match?.groups) {
      for (const [key, value] of Object.entries(match.groups)) {
        const namedKey = config.routeKeys[key];
        expoUrl.searchParams.set(namedKey, value);
        params[namedKey] = value;
      }
    }

    request[NON_STANDARD_SYMBOL] = {
      url: expoUrl,
    };
    return params;
  }

  return async function handler(request: ExpoRequest): Promise<Response> {
    if (getInternalRoutesManifest) {
      const manifest = await getInternalRoutesManifest(distFolder);
      if (manifest) {
        routesManifest = manifest;
      } else {
        // Development error when Expo Router is not setup.
        return new ExpoResponse('No routes manifest found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain',
          },
        });
      }
    } else if (!routesManifest) {
      routesManifest = getRoutesManifest(distFolder);
    }

    const url = new URL(request.url, 'http://expo.dev');

    const sanitizedPathname = url.pathname;

    debug('Request', sanitizedPathname);

    if (request.method === 'GET' || request.method === 'HEAD') {
      // First test static routes
      for (const route of routesManifest.htmlRoutes) {
        if (!route.namedRegex.test(sanitizedPathname)) {
          continue;
        }

        // // Mutate to add the expoUrl object.
        updateRequestWithConfig(request, route);

        // serve a static file
        const contents = await getHtml(request, route);

        // TODO: What's the standard behavior for malformed projects?
        if (!contents) {
          return new ExpoResponse('Not found', {
            status: 404,
            headers: {
              'Content-Type': 'text/plain',
            },
          });
        } else if (contents instanceof ExpoResponse) {
          return contents;
        }

        return new ExpoResponse(contents, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
          },
        });
      }
    }

    // Next, test API routes
    for (const route of routesManifest.apiRoutes) {
      if (!route.namedRegex.test(sanitizedPathname)) {
        continue;
      }

      const func = await getApiRoute(route);

      if (func instanceof ExpoResponse) {
        return func;
      }

      const routeHandler = func?.[request.method];
      if (!routeHandler) {
        return new ExpoResponse('Method not allowed', {
          status: 405,
          headers: {
            'Content-Type': 'text/plain',
          },
        });
      }

      // Mutate to add the expoUrl object.
      const params = updateRequestWithConfig(request, route);

      try {
        // TODO: Handle undefined
        return (await routeHandler(request, params)) as ExpoResponse;
      } catch (error) {
        if (error instanceof Error) {
          logApiRouteExecutionError(error);
        }

        return new ExpoResponse('Internal server error', {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
          },
        });
      }
    }

    // Finally, test 404 routes
    for (const route of routesManifest.notFoundRoutes) {
      if (!route.namedRegex.test(sanitizedPathname)) {
        continue;
      }

      // // Mutate to add the expoUrl object.
      updateRequestWithConfig(request, route);

      // serve a static file
      const contents = await getHtml(request, route);

      // TODO: What's the standard behavior for malformed projects?
      if (!contents) {
        return new ExpoResponse('Not found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain',
          },
        });
      } else if (contents instanceof ExpoResponse) {
        return contents;
      }

      return new ExpoResponse(contents, {
        status: 404,
        headers: {
          'Content-Type': 'text/html',
        },
      });
    }

    // 404
    const response = new ExpoResponse('Not found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
    return response;
  };
}

export { ExpoResponse, ExpoRequest };
