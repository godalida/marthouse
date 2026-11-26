import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type Hello = { mode: "local" | "hosted"; version: string; platform: string; signed_in: boolean; user?: { id: string; email: string; name: string }; workspaces?: { id: string; name: string; role: string }[] };
export type System = { mode: string; version: string; home: string; private_dir: string; setup_done: boolean; default_dbt: string; default_dbt_missing: boolean; role: string; workspace: string; example: string };
export type Settings = Record<string, any>;

export function useHello() {
  return useQuery<Hello>({ queryKey: ["hello"], queryFn: () => api("/api/system/hello"), staleTime: 60_000 });
}
export function useSystem(enabled = true) {
  return useQuery<System>({ queryKey: ["system"], queryFn: () => api("/api/system"), enabled, retry: false });
}
export function useSettings(enabled = true) {
  return useQuery<Settings>({ queryKey: ["settings"], queryFn: () => api("/api/settings"), enabled, retry: false });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useCallback(async (values: Settings) => {
    const s = await api("/api/settings", { method: "PATCH", body: values });
    qc.setQueryData(["settings"], s);
    return s;
  }, [qc]);
}

export type Project = {
  id: string; name: string; path: string; git_url: string; last_opened: string; exists: boolean; profile?: string; n_models?: number; branch?: string | null; error?: string;
  git?: { branch: string; changed: { status: string; path: string }[]; remote: string; ahead: number; behind: number } | null;
  stale?: string[]; has_manifest?: boolean; info?: any; dbt?: string | null; dbt_missing?: boolean; dbt_error?: string; dbt_override?: string;
  venv_has_dbt?: boolean; has_dlt?: boolean; venv_exists?: boolean; requirements?: boolean; profiles_path?: string;
};

export function useProject(pid?: string) {
  return useQuery<Project>({ queryKey: ["project", pid], queryFn: () => api(`/api/projects/${pid}`), enabled: !!pid, refetchInterval: 15_000 });
}

/** Which dbt target this browser runs against, per project. */
export function useTarget(pid?: string): [string, (t: string) => void] {
  const key = `marthouse.target.${pid}`;
  const [t, setT] = useState(() => localStorage.getItem(key) ?? "");
  useEffect(() => setT(localStorage.getItem(key) ?? ""), [key]);
  return [t, (v: string) => { localStorage.setItem(key, v); setT(v); window.dispatchEvent(new Event("marthouse-target")); }];
}

export function useTheme(appearance?: string) {
  const [sys, setSys] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const h = () => setSys(m.matches ? "dark" : "light");
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  const theme = appearance === "light" ? "light" : appearance === "auto" ? sys : "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.classList.add("mac");
    document.body.dataset.theme = theme;
  }, [theme]);
  return theme;
}
