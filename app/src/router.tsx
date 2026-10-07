import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/**
 * Minimal hash router. Hash URLs keep the app deployable to any static
 * host (GitHub Pages included) without server rewrites.
 */
export type Route =
  | { name: "overview" }
  | { name: "jobs" }
  | { name: "job"; id: bigint }
  | { name: "my-jobs" }
  | { name: "new" }
  | { name: "keeper" }
  | { name: "registry" }
  | { name: "not-found" };

export function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  if (path === "" || path === "overview") return { name: "overview" };
  if (path === "jobs") return { name: "jobs" };
  const job = /^jobs\/(\d+)$/.exec(path);
  if (job) return { name: "job", id: BigInt(job[1]) };
  if (path === "my-jobs") return { name: "my-jobs" };
  if (path === "new") return { name: "new" };
  if (path === "keeper") return { name: "keeper" };
  if (path === "registry") return { name: "registry" };
  return { name: "not-found" };
}

export function href(route: Route): string {
  switch (route.name) {
    case "job":
      return `#/jobs/${route.id}`;
    case "not-found":
      return "#/";
    default:
      return `#/${route.name}`;
  }
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function Link({
  to,
  className,
  children,
  onClick,
  ...rest
}: {
  to: Route;
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
}) {
  return (
    <a href={href(to)} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
