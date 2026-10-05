import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { formatAmount, jobStatus } from "@sorocron/sdk";
import { Icon, Logo, type IconName } from "./components/Icon";
import { Modal } from "./components/Modal";
import { Button, Segmented, ToastProvider, short, useToast } from "./components/ui";
import { ConnectModal } from "./modals";
import { JobDetail } from "./pages/JobDetail";
import { Jobs, MyJobs } from "./pages/Jobs";
import { Keeper } from "./pages/Keeper";
import { NewJob } from "./pages/NewJob";
import { Overview } from "./pages/Overview";
import { Registry } from "./pages/Registry";
import { Link, navigate, useRoute, type Route } from "./router";
import { NETWORK, RegistryProvider, useNow, useRegistry } from "./state/registry";
import { WalletProvider, useWallet } from "./state/wallet";

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <WalletProvider>
          <WalletBoundRegistry />
        </WalletProvider>
      </ToastProvider>
    </ThemeProvider>
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

// ---------------------------------------------------------------- theme

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: "light", setTheme: () => {} });

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#161615" : "#f7f6f3");
  }, [theme]);
  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem("sorocron.theme", t);
    } catch {
      // Storage may be unavailable; the choice still applies for this visit.
    }
  };
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

const useTheme = () => useContext(ThemeContext);

// ---------------------------------------------------------------- navigation

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

/** Routes shown full-screen on phones, without the tab bar. */
const FLOWS: Route["name"][] = ["new"];

function Shell() {
  const route = useRoute();
  const { error, refresh, jobs } = useRegistry();
  const { connectOpen, closeConnect } = useWallet();
  const [more, setMore] = useState(false);
  const now = useNow();
  const due = jobs.filter((j) => jobStatus(j, now) === "due").length;
  const flow = FLOWS.includes(route.name);

  useEffect(() => setMore(false), [route]);

  return (
    <div className={`shell ${flow ? "is-flow" : ""}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="ambient" aria-hidden="true" />

      <TopBar route={route} openMore={() => setMore(true)} />

      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-top">
          <Link to={{ name: "overview" }} className="brand">
            <Logo /> SoroCron
          </Link>
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

      {!flow && <TabBar route={route} due={due} openMore={() => setMore(true)} moreOpen={more} />}
      <MoreSheet open={more} onClose={() => setMore(false)} route={route} />
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

// ---------------------------------------------------------------- mobile chrome

/** Phone-only top bar. In a flow it becomes a close button and a title. */
function TopBar({ route, openMore }: { route: Route; openMore: () => void }) {
  const { account, promptConnect } = useWallet();
  if (FLOWS.includes(route.name)) {
    return (
      <header className="topbar flow-bar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          onClick={() => (window.history.length > 1 ? window.history.back() : navigate({ name: "overview" }))}
        >
          <Icon name="close" />
        </button>
        <span className="topbar-title">New job</span>
        <span className="topbar-spacer" />
      </header>
    );
  }
  return (
    <header className="topbar">
      <Link to={{ name: "overview" }} className="brand">
        <Logo size={24} /> SoroCron
      </Link>
      <span className="topbar-net">
        <span className="net-dot" /> Testnet
      </span>
      {account ? (
        <button type="button" className="avatar-btn" aria-label="Account and settings" onClick={openMore}>
          <span className="avatar" aria-hidden="true">
            {account.slice(1, 3)}
          </span>
        </button>
      ) : (
        <Button size="sm" variant="primary" onClick={promptConnect}>
          Connect
        </Button>
      )}
    </header>
  );
}

function TabBar({ route, due, openMore, moreOpen }: { route: Route; due: number; openMore: () => void; moreOpen: boolean }) {
  const tab = (to: Route, label: string, icon: IconName, match: Route["name"][], badge?: number) => {
    const active = !moreOpen && match.includes(route.name);
    return (
      <Link to={to} className={`tab ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}>
        <span className="tab-icon">
          <Icon name={icon} size={21} />
          {badge ? <span className="tab-badge">{badge}</span> : null}
        </span>
        <span>{label}</span>
      </Link>
    );
  };
  return (
    <nav className="tabbar" aria-label="Primary">
      {tab({ name: "overview" }, "Home", "overview", ["overview"])}
      {tab({ name: "jobs" }, "Jobs", "jobs", ["jobs", "job", "my-jobs"])}
      <Link to={{ name: "new" }} className="tab tab-new" aria-label="New job">
        <span className="tab-new-btn">
          <Icon name="plus" size={22} />
        </span>
      </Link>
      {tab({ name: "keeper" }, "Keeper", "keeper", ["keeper"], due)}
      <button type="button" className={`tab ${moreOpen || route.name === "registry" ? "active" : ""}`} onClick={openMore} aria-haspopup="dialog">
        <span className="tab-icon">
          <Icon name="menu" size={21} />
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

/** Phone-only menu sheet: account, secondary pages and appearance. */
function MoreSheet({ open, onClose, route }: { open: boolean; onClose: () => void; route: Route }) {
  const { account, promptConnect, disconnect } = useWallet();
  const { keeper } = useRegistry();
  const { theme, setTheme } = useTheme();
  const toast = useToast();

  const row = (to: Route, icon: IconName, label: string, hint: string) => (
    <Link to={to} className={`sheet-row ${route.name === to.name ? "current" : ""}`} onClick={onClose}>
      <span className="choice-icon">
        <Icon name={icon} size={17} />
      </span>
      <span className="sheet-row-text">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <Icon name="chevronRight" size={16} />
    </Link>
  );

  return (
    <Modal open={open} onClose={onClose} title="More" sheet>
      <section className="sheet-section">
        {account ? (
          <div className="account">
            <span className="avatar avatar-lg" aria-hidden="true">
              {account.slice(1, 3)}
            </span>
            <div className="account-text">
              <span className="mono">{short(account, 6, 6)}</span>
              <small>{keeper ? `Keeper · ${formatAmount(keeper.stake)} XLM staked` : "Connected with Freighter"}</small>
            </div>
            <div className="account-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label="Copy address"
                onClick={() => void navigator.clipboard?.writeText(account).then(() => toast("ok", "Address copied"))}
              >
                <Icon name="copy" size={17} />
              </button>
              <a className="icon-btn" aria-label="View on explorer" href={`${NETWORK.explorer}/account/${account}`} target="_blank" rel="noreferrer">
                <Icon name="external" size={17} />
              </a>
            </div>
          </div>
        ) : (
          <div className="account account-empty">
            <span className="choice-icon">
              <Icon name="wallet" size={17} />
            </span>
            <div className="account-text">
              <strong>No wallet connected</strong>
              <small>Connect Freighter to schedule and manage jobs.</small>
            </div>
          </div>
        )}
        {account ? (
          <Button
            className="wide"
            icon="logout"
            onClick={() => {
              disconnect();
              onClose();
            }}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            className="wide"
            variant="primary"
            icon="wallet"
            onClick={() => {
              onClose();
              promptConnect();
            }}
          >
            Connect Freighter
          </Button>
        )}
      </section>

      <section className="sheet-section sheet-links">
        {row({ name: "my-jobs" }, "user", "My jobs", "Jobs owned by your account")}
        {row({ name: "registry" }, "registry", "Registry", "Configuration, contracts and error codes")}
        <a className="sheet-row" href="https://github.com/sorocon-labs/sorocron" target="_blank" rel="noreferrer">
          <span className="choice-icon">
            <Icon name="book" size={17} />
          </span>
          <span className="sheet-row-text">
            <strong>Documentation</strong>
            <small>Source, guides and security model</small>
          </span>
          <Icon name="external" size={15} />
        </a>
      </section>

      <section className="sheet-section sheet-inline">
        <span>Appearance</span>
        <Segmented
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </section>
    </Modal>
  );
}

// ---------------------------------------------------------------- desktop sidebar

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
          <a role="menuitem" href={`${NETWORK.explorer}/account/${account}`} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
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

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="icon-btn icon-btn-xs theme-toggle" aria-label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
    </button>
  );
}
