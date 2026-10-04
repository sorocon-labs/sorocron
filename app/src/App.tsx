import { useEffect, useRef, useState } from "react";
import { formatAmount, jobStatus } from "@sorocron/sdk";
import { Icon, Logo, type IconName } from "./components/Icon";
import { Button, ToastProvider, short, useToast } from "./components/ui";
import { ConnectModal } from "./modals";
import { JobDetail } from "./pages/JobDetail";
import { Jobs, MyJobs } from "./pages/Jobs";
import { Keeper } from "./pages/Keeper";
import { NewJob } from "./pages/NewJob";
import { Overview } from "./pages/Overview";
import { Registry } from "./pages/Registry";
import { Link, useRoute, type Route } from "./router";
import { RegistryProvider, useNow, useRegistry } from "./state/registry";
import { WalletProvider, useWallet } from "./state/wallet";

export default function App() {
  return (
    <ToastProvider>
      <WalletProvider>
        <WalletBoundRegistry />
      </WalletProvider>
    </ToastProvider>
  );
}

function WalletBoundRegistry() {
  const { account } = useWallet();
  return (
    <RegistryProvider account={account}>
      <Shell />
    </RegistryProvider>
  );
}

interface NavItem {
  route: Route;
  label: string;
  icon: IconName;
  match: Route["name"][];
}

const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Explore",
    items: [
      { route: { name: "overview" }, label: "Overview", icon: "overview", match: ["overview"] },
      { route: { name: "jobs" }, label: "All jobs", icon: "jobs", match: ["jobs", "job"] },
    ],
  },
  {
    heading: "Manage",
    items: [
      { route: { name: "my-jobs" }, label: "My jobs", icon: "user", match: ["my-jobs"] },
      { route: { name: "new" }, label: "New job", icon: "plus", match: ["new"] },
    ],
  },
  {
    heading: "Network",
    items: [
      { route: { name: "keeper" }, label: "Keeper", icon: "keeper", match: ["keeper"] },
      { route: { name: "registry" }, label: "Registry", icon: "registry", match: ["registry"] },
    ],
  },
];

function Shell() {
  const route = useRoute();
  const { error, refresh, jobs } = useRegistry();
  const { connectOpen, closeConnect } = useWallet();
  const [drawer, setDrawer] = useState(false);
  const now = useNow();
  const due = jobs.filter((j) => jobStatus(j, now) === "due").length;

  useEffect(() => setDrawer(false), [route]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="ambient" aria-hidden="true" />

      <header className="mobilebar">
        <button type="button" className="icon-btn" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <Icon name="menu" />
        </button>
        <Link to={{ name: "overview" }} className="brand">
          <Logo /> SoroCron
        </Link>
        <span className="net-dot" aria-label="Testnet" />
      </header>

      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}
      <aside className={`sidebar ${drawer ? "open" : ""}`} aria-label="Primary">
        <div className="sidebar-top">
          <Link to={{ name: "overview" }} className="brand">
            <Logo /> SoroCron
          </Link>
          <button type="button" className="icon-btn drawer-close" aria-label="Close navigation" onClick={() => setDrawer(false)}>
            <Icon name="close" />
          </button>
        </div>

        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.heading} className="nav-group">
              <div className="nav-heading">{group.heading}</div>
              {group.items.map((item) => {
                const active = item.match.includes(route.name);
                return (
                  <Link key={item.label} to={item.route} className={`nav-item ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                    {item.route.name === "keeper" && due > 0 && <span className="nav-count">{due}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="network-row">
            <span className="net-dot" />
            <span>Testnet</span>
            <ThemeToggle />
          </div>
          <WalletCard />
        </div>
      </aside>

      <main id="main" className="main" tabIndex={-1}>
        {error && (
          <div className="banner" role="alert">
            <Icon name="alert" size={16} />
            <span>Couldn't reach the registry: {error}</span>
            <button type="button" className="link-btn" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        <div className="page" key={route.name === "job" ? `job-${route.id}` : route.name}>
          <Page route={route} />
        </div>
      </main>

      <ConnectModal open={connectOpen} onClose={closeConnect} />
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "overview":
      return <Overview />;
    case "jobs":
      return <Jobs />;
    case "job":
      return <JobDetail id={route.id} />;
    case "my-jobs":
      return <MyJobs />;
    case "new":
      return <NewJob />;
    case "keeper":
      return <Keeper />;
    case "registry":
      return <Registry />;
    default:
      return (
        <div className="notfound">
          <h1>Page not found</h1>
          <Link to={{ name: "overview" }} className="btn btn-secondary">
            Go to overview
          </Link>
        </div>
      );
  }
}

function WalletCard() {
  const { account, promptConnect, disconnect } = useWallet();
  const { keeper } = useRegistry();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!account) {
    return (
      <Button variant="primary" icon="wallet" className="wallet-connect" onClick={promptConnect}>
        Connect wallet
      </Button>
    );
  }

  return (
    <div className="wallet" ref={ref}>
      <button type="button" className="wallet-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <span className="avatar" aria-hidden="true">
          {account.slice(1, 3)}
        </span>
        <span className="wallet-text">
          <span className="mono">{short(account, 4, 4)}</span>
          <small>{keeper ? `Keeper · ${formatAmount(keeper.stake)} XLM staked` : "Freighter"}</small>
        </span>
        <Icon name="chevronDown" size={15} />
      </button>
      {menu && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(account).then(() => toast("ok", "Address copied"));
              setMenu(false);
            }}
          >
            <Icon name="copy" size={16} /> Copy address
          </button>
          <a role="menuitem" href={`https://stellar.expert/explorer/testnet/account/${account}`} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
            <Icon name="external" size={16} /> View on explorer
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              disconnect();
              setMenu(false);
            }}
          >
            <Icon name="logout" size={16} /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

type Theme = "light" | "dark";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("sorocron.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // ignore
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-btn icon-btn-xs theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
        try {
          localStorage.setItem("sorocron.theme", next);
        } catch {
          // ignore
        }
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
    </button>
  );
}
