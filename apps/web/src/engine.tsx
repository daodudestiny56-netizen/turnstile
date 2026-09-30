import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { OwnDeposit, PlanOptions, PlannedExit, PreflightResult } from "@turnstile/core";
import type { EngineInfo, PlanResult, WorkerRequest, WorkerResponse } from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Talks to the analysis worker. One per page load. */
class Engine {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error));
    };
  }

  private call<T>(req: WithoutId<WorkerRequest>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  init(): Promise<EngineInfo> {
    return this.call({ type: "init", base: new URL("snapshot/", document.baseURI).href });
  }

  check(exit: PlannedExit, own?: OwnDeposit): Promise<PreflightResult> {
    return this.call({ type: "check", exit, ...(own ? { own } : {}) });
  }

  plan(options: PlanOptions): Promise<PlanResult> {
    return this.call({ type: "plan", options });
  }
}

export type EngineState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: EngineInfo };

interface EngineContextValue {
  state: EngineState;
  engine: Engine;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export function EngineProvider({ children }: { children: ReactNode }): ReactNode {
  const [engine] = useState(() => new Engine());
  const [state, setState] = useState<EngineState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    engine.init().then(
      (info) => live && setState({ status: "ready", info }),
      (err: Error) => live && setState({ status: "error", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [engine]);
  return <EngineContext.Provider value={{ state, engine }}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const value = useContext(EngineContext);
  if (!value) throw new Error("useEngine outside EngineProvider");
  return value;
}
