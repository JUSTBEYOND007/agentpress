import { Module } from '@nestjs/common';

import { WorkerLifecycle } from './worker-lifecycle.js';

@Module({
  providers: [WorkerLifecycle],
})
export class AppModule {}
