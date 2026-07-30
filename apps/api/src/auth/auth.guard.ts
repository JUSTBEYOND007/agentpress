import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthService, type AuthenticatedUser } from './auth.service.js';

const PUBLIC_ROUTE = 'agentpress.public-route';

export const PublicRoute = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);

export type AuthenticatedRequest = {
  readonly headers: { readonly authorization?: string };
  user?: AuthenticatedUser;
};

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.user = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
