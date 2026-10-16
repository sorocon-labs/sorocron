import { Icon } from "./Icon";
import { relative } from "./ui";
import { Link } from "../router";
import { useNow, useRegistry } from "../state/registry";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Shown on every page while the admin has announced a registry upgrade
 * (#131), so job owners and keepers have the time the timelock gives them
 * to withdraw or unbond if they disagree with the new code.
 */
export function UpgradeBanner() {
  const { pendingUpgrade } = useRegistry();
  const now = useNow();
  if (!pendingUpgrade) return null;
  const hash = hex(pendingUpgrade.wasm_hash);
  const ready = pendingUpgrade.available_at <= now;
  return (
    <div className="banner notice" role="region" aria-label="Announced registry upgrade">
      <Icon name="alert" size={16} />
      <span>
        A registry upgrade to code <span className="mono" title={hash}>{`${hash.slice(0, 8)}…${hash.slice(-8)}`}</span> was announced.{" "}
        {ready ? "The admin can apply it now." : `It can be applied ${relative(pendingUpgrade.available_at, now)}.`} Job owners can withdraw and
        keepers can unbond before then.
      </span>
      <Link to={{ name: "registry" }}>Details</Link>
    </div>
  );
}
