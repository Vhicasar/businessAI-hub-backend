/**
 * Prometheus metrics without a dependency (Part I §14 — observability).
 *
 * The codebase deliberately avoids SDKs where a small amount of explicit code
 * does the job (see the raw-fetch gateway clients), and the exposition format
 * is simple enough that pulling in a client library would cost more than it
 * saves. Everything here is process-local; scrape /metrics to aggregate.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Counter {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ''} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ''} ${value}`);
    }
    return lines.join('\n');
  }
}

/** Fixed-bucket histogram — enough for latency SLOs without a dependency. */
class Histogram {
  private buckets = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const counts = this.buckets.get(key) ?? new Array(this.bounds.length).fill(0);
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= (this.bounds[i] as number)) counts[i] += 1;
    }
    this.buckets.set(key, counts);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, counts] of this.buckets) {
      const prefix = key ? `${key},` : '';
      this.bounds.forEach((bound, i) => {
        lines.push(`${this.name}_bucket{${prefix}le="${bound}"} ${counts[i]}`);
      });
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.counts.get(key) ?? 0}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${this.counts.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('vhicasar_http_requests_total', 'HTTP requests by method, route and status'),
  httpDuration: new Histogram('vhicasar_http_request_duration_ms', 'HTTP request duration in milliseconds'),
  httpErrors: new Counter('vhicasar_http_errors_total', 'HTTP responses with status >= 500'),
  paymentsTotal: new Counter('vhicasar_payments_total', 'Vhicasar Pay payment outcomes'),
  payoutsTotal: new Counter('vhicasar_payouts_total', 'Bank payout outcomes'),
  fraudDecisions: new Counter('vhicasar_fraud_decisions_total', 'Fraud engine decisions'),
  webhookDeliveries: new Counter('vhicasar_webhook_deliveries_total', 'Outbound webhook delivery outcomes'),
  domainEvents: new Counter('vhicasar_domain_events_total', 'Domain events published'),
  aiCalls: new Counter('vhicasar_ai_calls_total', 'AI provider calls'),
  outboxPending: new Gauge('vhicasar_event_outbox_pending', 'Domain events awaiting dispatch'),
  processUptime: new Gauge('vhicasar_process_uptime_seconds', 'Process uptime in seconds'),
  memoryBytes: new Gauge('vhicasar_process_memory_bytes', 'Resident memory in bytes'),

  /** Prometheus text exposition of every registered metric. */
  render(): string {
    this.processUptime.set(Math.round(process.uptime()));
    this.memoryBytes.set(process.memoryUsage().rss);
    return (
      [
        this.httpRequests,
        this.httpDuration,
        this.httpErrors,
        this.paymentsTotal,
        this.payoutsTotal,
        this.fraudDecisions,
        this.webhookDeliveries,
        this.domainEvents,
        this.aiCalls,
        this.outboxPending,
        this.processUptime,
        this.memoryBytes,
      ]
        .map((m) => m.render())
        .join('\n\n') + '\n'
    );
  },
};
