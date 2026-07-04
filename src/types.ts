// Shared types.

export type Engram = {
  id: number;
  content: string;
  original: string | null;
  location: string | null;
  category: string;
  importance: number;
  embedding: number[];
  embedding_dim: number;
  metadata: Record<string, unknown>;
  tags: string[];
  project_id: string;
  supersedes_id: number | null;
  superseded_at: string | null;
  supersession_type: string | null;
  valid_from: string | null;
  valid_until: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type ProcedureStep = {
  action: "log" | "set_context" | "validate" | "delay";
  message?: string;
  key?: string;
  value?: unknown;
  error?: string;
  ms?: number;
};

export type Procedure = {
  id: number;
  name: string;
  description: string;
  steps: ProcedureStep[];
};

export type ProcedureRunResult = {
  procedure: string;
  status: "ok" | "error";
  steps: Array<{
    index: number;
    action: string;
    status: "ok" | "error";
    [k: string]: unknown;
  }>;
  context: Record<string, unknown>;
  error: string | null;
  duration_ms: number;
};

export type StoreOptions = {
  category?: string;
  importance?: number;
  project_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  valid_from?: string | Date | null;
  valid_until?: string | Date | null;
  dimensions?: number;
  embedding?: number[];
  original?: string;
  location?: string;
};

export type SearchOptions = {
  limit?: number;
  min_similarity?: number;
  category?: string;
  project_id?: string;
  embedding?: number[];
};

export type ListOptions = {
  limit?: number;
  offset?: number;
  category?: string;
  project_id?: string;
  include_archived?: boolean;
};

export type ToolError =
  | { kind: "missing_field"; field: string }
  | { kind: "invalid_input"; reason: string }
  | { kind: "not_found"; id: number }
  | { kind: "already_superseded" }
  | { kind: "unknown_op"; op: string }
  | { kind: "unknown_tool"; tool: string }
  | { kind: "unknown_action"; action: string }
  | { kind: "unknown_procedure"; name: string }
  | { kind: "file_read_failed"; path: string; reason: string }
  | { kind: "internal"; message: string };