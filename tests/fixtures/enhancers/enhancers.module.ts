import {
  Catch,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  Module,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentMetadata,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type ArgumentsHost,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ProtocolError } from '@modelcontextprotocol/server';
import { map, type Observable } from 'rxjs';
import * as z from 'zod';
import {
  McpExecutionContext,
  McpModule,
  Prompt,
  ResourceTemplate,
  Tool,
  type McpContext,
  type McpContextType,
} from '../../../lib/index.js';

/** What the enhancers saw, in order. */
@Injectable()
export class CallLog {
  readonly entries: string[] = [];
  clear() {
    this.entries.length = 0;
  }
}

export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

/** Lets a call through when the `x-role` header names one of the method's roles. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly log: CallLog,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get<string[] | undefined>('roles', context.getHandler());
    const mcp = McpExecutionContext.create(context);
    this.log.entries.push(`guard ${mcp.getKind()} ${mcp.getName()}`);
    if (!roles) {
      return true;
    }
    const role = mcp.getContext().requestInfo?.headers.get('x-role');
    return role !== null && role !== undefined && roles.includes(role);
  }
}

/** Every call, globally (APP_GUARD): records the context type. */
@Injectable()
export class GlobalGuard implements CanActivate {
  constructor(private readonly log: CallLog) {}

  canActivate(context: ExecutionContext): boolean {
    this.log.entries.push(`global guard ${context.getType<McpContextType>()}`);
    return true;
  }
}

/** Every call, globally (APP_INTERCEPTOR): before and after. On the HTTP route, it sets a header on the response. */
@Injectable()
export class GlobalInterceptor implements NestInterceptor {
  constructor(private readonly log: CallLog) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<McpContextType>() !== 'mcp') {
      if (context.getType() === 'http') {
        const response = context.switchToHttp().getResponse<{ header(name: string, value: string): unknown }>();
        response.header('x-request-id', 'req-1');
      }
      return next.handle();
    }
    const name = McpExecutionContext.create(context).getName();
    this.log.entries.push(`global interceptor before ${name}`);
    return next.handle().pipe(
      map((value) => {
        this.log.entries.push(`global interceptor after ${name}`);
        return value;
      }),
    );
  }
}

/** Upper-cases a string result. */
@Injectable()
export class ShoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => (typeof value === 'string' ? value.toUpperCase() : value)));
  }
}

/** Trims every string of the input, which it sees as the call's body. */
@Injectable()
export class TrimPipe implements PipeTransform {
  constructor(private readonly log: CallLog) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    this.log.entries.push(`pipe ${metadata.type}`);
    if (metadata.type !== 'body' || typeof value !== 'object' || value === null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, typeof item === 'string' ? item.trim() : item]),
    );
  }
}

export class QuotaExceededError extends Error {}

/** Answers a QuotaExceededError with a tool result of its own. */
@Catch(QuotaExceededError)
export class QuotaFilter implements ExceptionFilter {
  catch(exception: QuotaExceededError, host: ArgumentsHost) {
    const mcp = McpExecutionContext.create(host);
    return {
      content: [{ type: 'text', text: `${mcp.getName()}: ${exception.message}, try again tomorrow` }],
      isError: true,
    };
  }
}

export class LegacyStoreError extends Error {}

/** A global filter (APP_FILTER) that turns LegacyStoreError into a protocol error on MCP calls. */
@Catch(LegacyStoreError)
export class GlobalFilter implements ExceptionFilter {
  catch(exception: LegacyStoreError, host: ArgumentsHost) {
    if (host.getType<McpContextType>() !== 'mcp') {
      throw exception;
    }
    throw new ProtocolError(-32001, `Store unavailable: ${exception.message}`, { retryAfter: 30 });
  }
}

/** A custom parameter decorator, as `@CurrentUser()` is one: the `x-role` header of the call. */
export const CallerRole = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    McpExecutionContext.create(context).getContext().requestInfo?.headers.get('x-role') ?? 'guest',
);

@Injectable()
@UseGuards(RolesGuard)
export class GuardedTools {
  constructor(private readonly log: CallLog) {}

  @Tool({ description: 'Open to everyone' })
  ping() {
    this.log.entries.push('handler ping');
    return 'pong';
  }

  @Tool({ description: 'Admins only' })
  @Roles('admin')
  purge() {
    return 'purged';
  }

  @ResourceTemplate({ uriTemplate: 'secrets://{name}' })
  @Roles('admin')
  secret({ name }: { name: string }) {
    return `the ${name} secret`;
  }

  @Prompt({ description: 'Admins only' })
  @Roles('admin')
  audit() {
    return 'Audit everything.';
  }

  @Tool({ description: 'Shouts', inputSchema: z.object({ text: z.string() }) })
  @UseInterceptors(ShoutInterceptor)
  @UsePipes(TrimPipe)
  shout({ text }: { text: string }) {
    this.log.entries.push(`handler shout "${text}"`);
    return text;
  }

  @Tool({ description: 'Over quota' })
  @UseFilters(QuotaFilter)
  quota() {
    throw new QuotaExceededError('Daily quota exceeded');
  }

  @ResourceTemplate({ uriTemplate: 'store://{key}' })
  store({ key }: { key: string }) {
    throw new LegacyStoreError(key);
  }

  @Tool({ description: 'Reads the execution context' })
  context(_input: unknown, ctx: McpContext) {
    return { kind: ctx.kind, name: ctx.name };
  }

  @Tool({ description: 'Greets the caller by role', inputSchema: z.object({ greeting: z.string() }) })
  greet({ greeting }: { greeting: string }, _ctx: McpContext, @CallerRole() role: string) {
    return `${greeting}, ${role}`;
  }

  @Tool({ description: 'Forbidden in the handler' })
  forbidden() {
    throw new ForbiddenException('Not your note');
  }
}

@Module({
  imports: [McpModule.forRoot({ name: 'enhancers', version: '1.0.0' })],
  providers: [
    CallLog,
    GuardedTools,
    { provide: APP_GUARD, useClass: GlobalGuard },
    { provide: APP_INTERCEPTOR, useClass: GlobalInterceptor },
    { provide: APP_FILTER, useClass: GlobalFilter },
  ],
})
export class EnhancersAppModule {}
