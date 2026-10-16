import type { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { createSqsClient, QUEUE_URLS, resolveQueueUrls, SQS_CLIENT } from './sqs';

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [ENV], useFactory: (env: Env) => createSqsClient(env) },
    {
      provide: QUEUE_URLS,
      inject: [SQS_CLIENT, ENV],
      useFactory: (client: SQSClient, env: Env) => resolveQueueUrls(client, env),
    },
  ],
  exports: [SQS_CLIENT, QUEUE_URLS],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
