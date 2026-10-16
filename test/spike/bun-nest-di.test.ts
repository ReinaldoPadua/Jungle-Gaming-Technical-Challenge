/**
 * Spike 1 — NestJS sob Bun: decorators + emitDecoratorMetadata.
 * Se a injeção por tipo de construtor funcionar, o transpiler do Bun está
 * emitindo `design:paramtypes` corretamente.
 */
import { describe, expect, test } from 'bun:test';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Injectable()
class Clock {
  now(): Date {
    return new Date('2026-01-01T00:00:00.000Z');
  }
}

@Injectable()
class Greeter {
  constructor(private readonly clock: Clock) {}
  greet(): string {
    return `hello @ ${this.clock.now().toISOString()}`;
  }
}

@Module({ providers: [Clock, Greeter] })
class SpikeModule {}

describe('spike: Nest DI on Bun', () => {
  test('emits design:paramtypes metadata', () => {
    expect(Reflect.getMetadata('design:paramtypes', Greeter)).toEqual([Clock]);
  });

  test('resolves constructor-injected providers', async () => {
    const ctx = await NestFactory.createApplicationContext(SpikeModule, { logger: false });
    expect(ctx.get(Greeter).greet()).toBe('hello @ 2026-01-01T00:00:00.000Z');
    await ctx.close();
  });
});
