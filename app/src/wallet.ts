import { getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

export { signTransaction };

/** Asks Freighter for access and returns the account, checking it's on the expected network. */
export async function connectFreighter(expectedPassphrase: string): Promise<string> {
  const installed = await isConnected();
  if (!installed.isConnected) {
    throw new Error("Freighter isn't installed. Get it at freighter.app, then reload this page.");
  }
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);

  const network = await getNetworkDetails();
  if (!network.error && network.networkPassphrase !== expectedPassphrase) {
    throw new Error(`Freighter is on ${network.network}. Switch it to Testnet to use SoroCron.`);
  }
  return access.address;
}
