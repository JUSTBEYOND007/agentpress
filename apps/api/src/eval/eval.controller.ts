import { ExperimentStore } from '@agentpress/agent-evals';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.js';
import type { AuthenticatedUser } from '../auth/auth.service.js';
import { AuthorizationService } from '../auth/authorization.service.js';

@Controller('workspaces/:workspaceId/evals')
export class EvalController {
  public constructor(
    @Inject(ExperimentStore) private readonly experiments: ExperimentStore,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  @Get('experiments')
  public async listExperiments(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') rawLimit: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isSafeInteger(limit)) {
      throw new BadRequestException('limit must be an integer');
    }
    try {
      return await this.experiments.listWorkspaceExperiments(workspaceId, limit);
    } catch (error) {
      if (error instanceof RangeError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get('experiments/:experimentId/report')
  public async report(
    @Param('workspaceId') workspaceId: string,
    @Param('experimentId') experimentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const report = await this.experiments.getWorkspaceExperimentReport(workspaceId, experimentId);
    if (!report) throw new NotFoundException('Evaluation experiment does not exist');
    return report;
  }

  @Get('trials/:trialId/trace')
  public async trace(
    @Param('workspaceId') workspaceId: string,
    @Param('trialId') trialId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const trace = await this.experiments.getWorkspaceTrialTrace(workspaceId, trialId);
    if (!trace) throw new NotFoundException('Evaluation Trial trace does not exist');
    return trace;
  }

  @Get('regression-trend')
  public async regressionTrend(
    @Param('workspaceId') workspaceId: string,
    @Query('experimentName') experimentName: string | undefined,
    @Query('arm') arm: string | undefined,
    @Query('metricKey') metricKey: string | undefined,
    @Query('limit') rawLimit: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.authorization.assertWorkspaceMember(workspaceId, user.id);
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (!experimentName?.trim() || !arm?.trim() || !metricKey?.trim()) {
      throw new BadRequestException('experimentName, arm, and metricKey are required');
    }
    if (limit !== undefined && !Number.isSafeInteger(limit)) {
      throw new BadRequestException('limit must be an integer');
    }
    try {
      return await this.experiments.listRegressionTrend({
        workspaceId,
        experimentName,
        arm,
        metricKey,
        ...(limit === undefined ? {} : { limit }),
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
