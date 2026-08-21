import { Resolver } from "node:dns";
import type { LookupAddress } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { config } from "./config.js";

/**
 * Some ISPs block exchange APIs at the resolver: the names return NXDOMAIN
 * while the hosts themselves answer normally. Pointing our own connections at a
 * public resolver routes around that without touching system DNS or a VPN.
 *
 * Node's built-in fetch dispatches through undici, so overriding the global
 * dispatcher's `lookup` covers every request the scanner makes.
 */

interface CacheEntry {
  addrs: LookupAddress[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Respect record TTLs, but never thrash on a 5s TTL nor pin a rotating
// CloudFront address for longer than a scan interval.
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 300_000;

function resolveWithTtl(
  resolver: Resolver,
  hostname: string,
  family: 4 | 6,
): Promise<CacheEntry> {
  return new Promise((resolve, reject) => {
    const cb = (
      err: NodeJS.ErrnoException | null,
      records: Array<{ address: string; ttl: number }>,
    ) => {
      if (err) return reject(err);
      if (!records.length) return reject(new Error(`no A/AAAA for ${hostname}`));
      const ttl = Math.min(
        MAX_TTL_MS,
        Math.max(MIN_TTL_MS, Math.min(...records.map((r) => r.ttl)) * 1000),
      );
      resolve({
        addrs: records.map((r) => ({ address: r.address, family })),
        expiresAt: Date.now() + ttl,
      });
    };
    if (family === 6) resolver.resolve6(hostname, { ttl: true }, cb);
    else resolver.resolve4(hostname, { ttl: true }, cb);
  });
}

/**
 * Installs a DNS-overriding global dispatcher when DNS_SERVERS is set.
 * No-op otherwise, so the default stays "use the system resolver".
 */
export function installDnsOverride(): void {
  const servers = config.DNS_SERVERS;
  if (!servers.length) return;

  const resolver = new Resolver();
  resolver.setServers(servers);

  const lookup = (
    hostname: string,
    // Node types family as number | "IPv4" | "IPv6"; both spellings mean the same.
    options: { family?: number | "IPv4" | "IPv6"; all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) {
      return void callback(
        null,
        options.all ? cached.addrs : cached.addrs[0]!.address,
        cached.addrs[0]!.family,
      );
    }

    const wants6 = options.family === 6 || options.family === "IPv6";
    resolveWithTtl(resolver, hostname, wants6 ? 6 : 4)
      // family 0 means "either" — only then is the other record type a fallback.
      .catch((err: unknown) =>
        options.family
          ? Promise.reject(err)
          : resolveWithTtl(resolver, hostname, 6),
      )
      .then((entry) => {
        cache.set(hostname, entry);
        callback(
          null,
          options.all ? entry.addrs : entry.addrs[0]!.address,
          entry.addrs[0]!.family,
        );
      })
      .catch((err: unknown) => {
        callback(
          Object.assign(
            new Error(
              `DNS lookup for ${hostname} failed via ${servers.join(", ")}: ` +
                `${(err as Error).message}`,
            ),
            { code: (err as NodeJS.ErrnoException).code },
          ),
          "",
        );
      });
  };

  setGlobalDispatcher(new Agent({ connect: { lookup } }));
}
