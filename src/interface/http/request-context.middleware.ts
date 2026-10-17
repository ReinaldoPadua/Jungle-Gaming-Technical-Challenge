import type { AppLogger } from '../../shared/application/logger';
import type { Metrics } from '../../shared/application/metrics';
import { logContext } from '../../shared/application/log-context';
import { correlationIdFromHeader } from './correlation';

interface Req {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  baseUrl?: string;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', cb: () => void): void;
}

/**
 * Abre o contexto de log da requisição (correlationId), devolve o
 * X-Correlation-Id na resposta e registra uma linha + métricas por requisição.
 * Rótulo de rota = padrão do Express (ex.: /wallets/:walletId) — sem ids na métrica.
 */
export function requestContextMiddleware(logger: AppLogger, metrics: Metrics) {
  return (req: Req, res: Res, next: () => void): void => {
    const header = req.headers['x-correlation-id'];
    const correlationId = correlationIdFromHeader(Array.isArray(header) ? header[0] : header);
    res.setHeader('X-Correlation-Id', correlationId);
    const startedAt = performance.now();

    logContext.run({ correlationId }, () => {
      res.on('finish', () => {
        const durationMs = performance.now() - startedAt;
        const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
        const labels = { method: req.method, route, status: String(res.statusCode) };
        metrics.increment('http_requests_total', labels);
        metrics.observe('http_request_duration_seconds', durationMs / 1000, labels);
        // health e métricas não poluem o log
        if (!route.startsWith('/health') && route !== '/metrics') {
          const level = res.statusCode >= 500 ? 'error' : 'info';
          logger[level]('http request', { method: req.method, route, status: res.statusCode, durationMs: Math.round(durationMs) });
        }
      });
      next();
    });
  };
}
