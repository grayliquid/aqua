import { serve } from "https://deno.land/std@0.185.0/http/server.ts";
import { ResponseError } from "./response-error.ts";

export type AquaOptionsCustomListenFn = ({
  handlerFn,
  abortSignal,
}: {
  handlerFn: (request: Request) => Response | Promise<Response>;
  abortSignal: AbortSignal;
}) => void | Promise<void>;

export interface AquaOptions {
  /**
   * `listen` either takes options that will be passed
   * to the std/http `serve` function, or a custom function
   * that starts the listening process and makes use of
   * Aqua's request handler function.
   *
   * @example
   * {
   *   port: 80
   * }
   *
   * @example
   * // `abortSignal` ignored for the sake of simplicity
   * async ({ handlerFn, abortSignal }) => {
   *   const conn = Deno.listen({ port: 80 });
   *   const httpConn = Deno.serveHttp(await conn.accept());
   *   const e = await httpConn.nextRequest();
   *   if (e) e.respondWith(await handlerFn(e.request));
   * }
   */
  listen?:
    | {
        port?: number;
        hostname?: string;
      }
    | AquaOptionsCustomListenFn;
}

export enum Method {
  GET = "GET",
  HEAD = "HEAD",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE",
  CONNECT = "CONNECT",
  OPTIONS = "OPTIONS",
  TRACE = "TRACE",
  PATCH = "PATCH",
}

export type StepFn<_Event extends Event> = (
  event: _Event
) => _Event | Promise<_Event> | void;

export type RespondFn<_Event extends Event> = (
  event: _Event
) => _Event["response"] | Promise<_Event["response"]>;

export interface RouteOptions<_Event extends Event> {
  steps?: StepFn<_Event>[];
}

export interface BranchOptions<_Event extends Event>
  extends Required<Pick<RouteOptions<_Event>, "steps">> {
  path: string;
  method: Method;
  aquaInstance: Aqua;
}

export interface Event {
  request: Request;
  response: Response;
  /**
   * Responds to the event with the currently set `response`.
   * This function should not be called multiple times.
   * @todo Is there maybe a way to allow no statements after this fn has been called?
   */
  end(): void;
  [key: string]: unknown;
}

interface InternalEvent extends Event {
  _internal: {
    hasCalledEnd: boolean;
  };
}

type InternalizedEvent<_Event extends Event> = _Event & InternalEvent;

function getDefaultResponse() {
  return new Response("Not found.", { status: 404 });
}

function parseRequestPath(url: string) {
  return url.replace(/(\?(.*))|(\#(.*))/, "");
}

export class Branch<_Event extends Event> {
  private options: BranchOptions<_Event>;
  private steps: StepFn<_Event>[] = [];

  public _internal = {
    respond: async (event: InternalizedEvent<_Event>) => {
      for (const step of this.steps) {
        const returnedEvent = await step(event);

        // Called `event.end()`. Ignore all further statements.
        if (event._internal.hasCalledEnd) {
          break;
        }

        if (!returnedEvent) {
          continue;
        }

        event = returnedEvent as InternalizedEvent<_Event>;
      }

      return event.response;
    },
  };

  constructor(options: BranchOptions<_Event>) {
    this.steps = options.steps;
    this.options = options;
  }

  public step<_StepFn extends StepFn<_Event>>(stepFn: _StepFn) {
    this.steps.push(stepFn);

    return this as Awaited<ReturnType<_StepFn>> extends never
      ? never
      : Awaited<ReturnType<_StepFn>> extends _Event
      ? Branch<Awaited<ReturnType<_StepFn>>>
      : this;
  }

  public respond<_RespondFn extends RespondFn<_Event>>(respondFn: _RespondFn) {
    this.steps.push(async (event) => {
      event.response = await respondFn(event);
      return event;
    });

    return this as unknown as Branch<
      _Event & {
        response: Awaited<ReturnType<_RespondFn>>;
      }
    >;
  }

  public route(
    path: string,
    method: Method,
    options: RouteOptions<_Event> = {}
  ) {
    return this.options.aquaInstance.route<_Event>(
      this.options.path + path,
      method,
      {
        steps: [...this.steps, ...(options?.steps ?? [])],
      }
    );
  }
}

export class Aqua<_Event extends Event = Event> {
  // @todo Solve this `any` situation
  protected routes: Record<string, Branch<any>> = {};
  private abortController: AbortController;

  constructor(options?: AquaOptions) {
    this.abortController = new AbortController();

    this.listen(options?.listen);
  }

  protected async listen(listen: AquaOptions["listen"]) {
    const handlerFn = async (request: Request) => {
      try {
        return await this.handleRequest(this.createInternalEvent(request));
      } catch (error) {
        if (error instanceof ResponseError) {
          return error.response;
        }

        return new Response(error, { status: 500 });
      }
    };

    if (typeof listen === "function") {
      await listen({
        handlerFn,
        abortSignal: this.abortController.signal,
      });
      return;
    }

    await serve(handlerFn, {
      hostname: listen?.hostname,
      port: listen?.port,
      signal: this.abortController.signal,
    });
  }

  protected createInternalEvent(request: Request): InternalEvent {
    return {
      _internal: {
        hasCalledEnd: false,
      },
      request,
      response: getDefaultResponse(),
      end() {
        if (this._internal.hasCalledEnd) return;
        this._internal.hasCalledEnd = true;
      },
    };
  }

  protected async handleRequest(event: InternalEvent) {
    const route =
      this.routes[
        event.request.method.toUpperCase() +
          parseRequestPath(new URL(event.request.url).pathname)
      ];

    if (!route) {
      return event.response;
    }

    return await route._internal.respond(event);
  }

  public route<__Event extends _Event>(
    path: string,
    method: Method,
    options: RouteOptions<__Event> = {}
  ): Branch<__Event> {
    if (!path.startsWith("/")) {
      throw new Error('Route paths must start with a "/".');
    }

    return (this.routes[method + path] = new Branch<__Event>({
      path,
      method,
      aquaInstance: this,
      steps: options.steps ?? [],
    }));
  }

  public kill() {
    this.abortController.abort();
  }

  public async fakeCall(request: Request): Promise<Response> {
    return await new Promise((resolve) => {
      this.handleRequest({
        _internal: {
          hasCalledEnd: false,
        },
        request,
        response: getDefaultResponse(),
        end() {
          if (this._internal.hasCalledEnd) return;
          this._internal.hasCalledEnd = true;

          const { body, ...init } = this.response;
          resolve(new Response(body, init));
        },
      });
    });
  }
}
