import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

@Injectable()
export class WorkerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private heartbeat: NodeJS.Timeout | undefined;

  onModuleInit(): void {
    this.heartbeat = setInterval(() => undefined, 30_000);
  }

  onApplicationShutdown(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
    }
  }
}
