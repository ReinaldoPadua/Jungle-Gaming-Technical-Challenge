import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, HttpCode, HttpStatus, Inject, ServiceUnavailableException } from '@nestjs/common';
import { QUEUE_URLS, type QueueUrls, SQS_CLIENT } from '../infrastructure/messaging/sqs';

type CheckResult = { status: 'up' } | { status: 'down'; error: string };

const TIMEOUT_MS = 2_000;

/** Endpoints de health: sem autenticação, por definição do desafio. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
  ) {}

  /** Liveness: o processo responde. Não toca dependências externas. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'up' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 se qualquer um falhar. */
  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.getConnection().execute('select 1')),
      this.check(() =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.wager, AttributeNames: ['QueueArn'] })),
      ),
    ]);
    const body = { status: postgres.status === 'up' && sqs.status === 'up' ? 'up' : 'down', checks: { postgres, sqs } };
    if (body.status !== 'up') throw new ServiceUnavailableException(body);
    return body;
  }

  private async check(fn: () => Promise<unknown>): Promise<CheckResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
        }),
      ]);
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
