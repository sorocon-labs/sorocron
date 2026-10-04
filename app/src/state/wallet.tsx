import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getAddress, getNetworkDetails, isAllowed, isConnected, requestAccess } from "@stellar/freighter-api";
import { NETWORK } from "./registry";

export { signTransaction } from "@stellar/freighter-api";

interface WalletState {
  account?: string;
  /** Asks Freighter for access. Throws with a readable message on failure. */
  connect: () => Promise<string>;
  disconnect: () => void;
  /** Opens the connect dialog. */
  promptConnect: () => void;
  connectOpen: boolean;
  closeConnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);
const REMEMBER_KEY = "sorocron.wallet";

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(REMEMBER_KEY, "freighter");
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Storage can be unavailable (private mode); the wallet still works for this visit.
  }
}

function remembered(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) === "freighter";
  } catch {
    return false;
  }
}

async function checkNetwork() {
  const network = await getNetworkDetails();
  if (!network.error && network.networkPassphrase !== NETWORK.networkPassphrase) {
    throw new Error(`Freighter is set to ${network.network}. Switch it to Testnet and try again.`);
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string>();
  const [connectOpen, setConnectOpen] = useState(false);
  const promptConnect = useCallback(() => setConnectOpen(true), []);
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  // Restore a previous session without prompting, if Freighter still allows this site.
  useEffect(() => {
    if (!remembered()) return;
    (async () => {
      const allowed = await isAllowed();
      if (!allowed.isAllowed) return remember(false);
      const { address, error } = await getAddress();
      if (!error && address) setAccount(address);
    })().catch(() => remember(false));
  }, []);

  const connect = useCallback(async () => {
    const installed = await isConnected();
    if (!installed.isConnected) {
      throw new Error("Freighter isn't installed in this browser.");
    }
    const access = await requestAccess();
    if (access.error) throw new Error(access.error.message);
    await checkNetwork();
    setAccount(access.address);
    remember(true);
    return access.address;
  }, []);

  const disconnect = useCallback(() => {
    setAccount(undefined);
    remember(false);
  }, []);

  return (
    <WalletContext.Provider value={{ account, connect, disconnect, promptConnect, connectOpen, closeConnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet outside WalletProvider");
  return ctx;
}
