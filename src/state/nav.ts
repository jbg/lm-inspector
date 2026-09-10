import { create } from "zustand";

export type View =
  | { name: "library" }
  | { name: "model"; path: string; repoId: string; tab: ModelTab }
  | { name: "lab" }
  | { name: "runs" }
  | { name: "compare"; a: string; b: string };

export type ModelTab =
  | "overview"
  | "architecture"
  | "tensors"
  | "tokenizer"
  | "config"
  | "observability";

interface NavState {
  view: View;
  stack: View[];
  go: (view: View) => void;
  back: () => void;
  setModelTab: (tab: ModelTab) => void;
}

export const useNav = create<NavState>((set) => ({
  view: { name: "library" },
  stack: [],
  go: (view) => set((s) => ({ view, stack: [...s.stack.slice(-24), s.view] })),
  back: () =>
    set((s) => {
      const prev = s.stack[s.stack.length - 1];
      return prev ? { view: prev, stack: s.stack.slice(0, -1) } : s;
    }),
  setModelTab: (tab) =>
    set((s) => (s.view.name === "model" ? { view: { ...s.view, tab } } : s)),
}));
