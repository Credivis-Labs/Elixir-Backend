/**
 * Minimal in-process metrics with a Prometheus text exposition. No dependency;
 * the relayer's metric set is small and fixed.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly latencies: number[] = [];

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = serializeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observeLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 10_000) this.latencies.shift();
  }

  get(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(serializeKey(name, labels)) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; latency: { p50: number; p95: number } } {
    return {
      counters: Object.fromEntries(this.counters),
      latency: { p50: this.percentile(0.5), p95: this.percentile(0.95) },
    };
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`);
    lines.push(`relayer_submission_latency_ms{quantile="0.5"} ${this.percentile(0.5)}`);
    lines.push(`relayer_submission_latency_ms{quantile="0.95"} ${this.percentile(0.95)}`);
    return lines.join("\n") + "\n";
  }

  private percentile(q: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  }
}

function serializeKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}
