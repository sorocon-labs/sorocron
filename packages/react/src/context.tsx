import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SoroCron, type ConnectOptions, type NetworkConfig } from "@sorocron/sdk";

/**
 * The client methods the hooks call. A `SoroCron` satisfies it; tests and
 * apps with their own data layer can pass anything that does.
 */
export type SoroCronClient = Pick<
  SoroCron,
  "getJob" | "allJobs" | "jobsByOwner" | "getKeeper" | "keeperStats" | "config" | "isDue"
>;

interface ContextValue {
  client?: SoroCronClient;
  error?: Error;
  /** Default polling interval for hooks, in milliseconds. */
  refreshMs: number;
}

const SoroCronContext = createContext<ContextValue | null>(null);

export interface SoroCronProviderProps {
  /** Network to connect to, e.g. `TESTNET` from `@sorocron/sdk`. */
  network?: NetworkConfig;
  /** Override the network's registry address. */
  contractId?: string;
  /** Wallet account and signer, to send transactions with `useSoroCron().client`. */
  wallet?: Pick<ConnectOptions, "publicKey" | "signTransaction" | "signAuthEntry">;
  /** Use an existing client instead of connecting. */
  client?: SoroCronClient;
  /** How often hooks refresh, in ms. Default 10 s, about two ledgers. */
  refreshMs?: number;
  children: ReactNode;
}

/**
 * Connects to a SoroCron registry once and shares the client with every
 * hook below it.
 *
 * ```tsx
 * <SoroCronProvider network={TESTNET}>
 *   <App />
 * </SoroCronProvider>
 * ```
 */
export function SoroCronProvider({ network, contractId, wallet, client, refreshMs = 10_000, children }: SoroCronProviderProps) {
  const [state, setState] = useState<{ client?: SoroCronClient; error?: Error }>({ client });

  useEffect(() => {
    if (client) {
      setState({ client });
      return;
    }
    if (!network) {
      setState({ error: new Error("SoroCronProvider needs a `network` or a `client`") });
      return;
    }
    let cancelled = false;
    SoroCron.connect({ network, contractId, ...wallet })
      .then((connected) => !cancelled && setState({ client: connected }))
      .catch((err) => !cancelled && setState({ error: err instanceof Error ? err : new Error(String(err)) }));
    return () => {
      cancelled = true;
    };
  }, [client, network, contractId, wallet?.publicKey, wallet?.signTransaction, wallet?.signAuthEntry]);

  return <SoroCronContext.Provider value={{ ...state, refreshMs }}>{children}</SoroCronContext.Provider>;
}

/** The shared client (undefined while connecting) and any connection error. */
export function useSoroCron(): ContextValue {
  const ctx = useContext(SoroCronContext);
  if (!ctx) throw new Error("SoroCron hooks must be used inside <SoroCronProvider>");
  return ctx;
}
