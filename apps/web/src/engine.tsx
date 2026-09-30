import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { OwnDeposit, PlanOptions, PlannedExit, PreflightResult } from "@turnstile/core";
import type { EngineInfo, PlanResult, WorkerRequest, WorkerResponse } from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Talks to the analysis worker. A crashed worker fails every pending call instead of hanging. */
class Engine {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: Error | undefined;

  constructor(onCrash: (e: Error) => void) {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error));
    };
    const crash = (message: string): void => {
      this.dead = new Error(message);
      for (const p of this.pending.values()) p.reject(this.dead);
      this.pending.clear();
      onCrash(this.dead);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      crash("The analysis engine stopped unexpectedly. Try again, or reload the page.");
    };
    this.worker.onmessageerror = () => crash("The analysis engine sent an unreadable reply.");
  }

  private call<T>(req: WithoutId<WorkerRequest>): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
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

  terminate(): void {
    this.worker.terminate();
  }
}

export type EngineState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: EngineInfo };

interface EngineContextValue {
  state: EngineState;
  engine: Engine;
  /** Start over with a fresh worker, after a load failure or crash. */
  retry: () => void;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export function EngineProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<EngineState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [engine, setEngine] = useState<Engine>();
  const live = useRef(0);

  useEffect(() => {
    const run = ++live.current;
    const e = new Engine((err) => {
      if (live.current === run) setState({ status: "error", message: err.message });
    });
    setEngine(e);
    setState({ status: "loading" });
    e.init().then(
      (info) => live.current === run && setState({ status: "ready", info }),
      (err: Error) => live.current === run && setState({ status: "error", message: err.message }),
    );
    return () => e.terminate();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  if (!engine) return null;
  return (
    <EngineContext.Provider value={{ state, engine, retry }}>{children}</EngineContext.Provider>
  );
}

export function useEngine(): EngineContextValue {
  const value = useContext(EngineContext);
  if (!value) throw new Error("useEngine outside EngineProvider");
  return value;
}

/**
 * Run async work so that only the latest call's result is kept: a slow earlier request can never
 * overwrite a newer one.
 */
export function useLatest(): <T>(work: Promise<T>) => Promise<{ current: boolean; value: T }> {
  const counter = useRef(0);
  return useCallback(async <T,>(work: Promise<T>) => {
    const mine = ++counter.current;
    const value = await work;
    return { current: mine === counter.current, value };
  }, []);
}
