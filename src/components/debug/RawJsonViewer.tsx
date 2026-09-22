"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Copy, Check, Search } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/primitives";
import { REDACTED } from "@/lib/mask";

/**
 * A readable view of an API payload.
 *
 * It is given data that has *already* been masked and redacted on the server
 * — this component never receives an unmasked payload, so there is nothing
 * here to accidentally reveal. Its job is legibility: collapsible nodes,
 * typed colouring, and a filter, instead of one long `JSON.stringify` wall.
 */

type Json = unknown;

function typeOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isContainer(value: Json): value is Record<string, Json> | Json[] {
  return value !== null && typeof value === "object";
}

function countChildren(value: Json): number {
  if (Array.isArray(value)) return value.length;
  if (isContainer(value)) return Object.keys(value).length;
  return 0;
}

/** Leaf rendering, with the redaction marker called out rather than quoted. */
function Leaf({ value }: { value: Json }) {
  if (value === REDACTED) {
    return (
      <span
        className="rounded bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning"
        title="Redacted before leaving the server"
      >
        {REDACTED}
      </span>
    );
  }
  const kind = typeOf(value);
  if (kind === "string") {
    const text = value as string;
    // A masked value keeps its bullets; show it as-is but muted.
    const masked = text.includes("•");
    return (
      <span className={masked ? "text-muted-foreground" : "text-success"}>
        &quot;{text}&quot;
      </span>
    );
  }
  if (kind === "number") return <span className="text-link">{String(value)}</span>;
  if (kind === "boolean")
    return <span className="text-warning">{String(value)}</span>;
  return <span className="text-muted-foreground">null</span>;
}

function Node({
  label,
  value,
  depth,
  defaultOpen,
  filter,
}: {
  label: string;
  value: Json;
  depth: number;
  defaultOpen: boolean;
  filter: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // A filter match anywhere below a node has to force it open, otherwise
  // searching would hide the very thing it found.
  const subtreeMatches = useMemo(() => {
    if (!filter) return false;
    const needle = filter.toLowerCase();
    if (label.toLowerCase().includes(needle)) return true;
    try {
      return JSON.stringify(value)?.toLowerCase().includes(needle) ?? false;
    } catch {
      return false;
    }
  }, [filter, label, value]);

  if (filter && !subtreeMatches) return null;

  if (!isContainer(value)) {
    return (
      <div
        className="flex gap-2 py-0.5 font-mono text-xs"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="shrink-0 text-foreground">{label}:</span>
        <span className="break-all">
          <Leaf value={value} />
        </span>
      </div>
    );
  }

  const children = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  const expanded = open || Boolean(filter);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1 py-0.5 text-left font-mono text-xs hover:bg-muted"
        style={{ paddingLeft: depth * 14 }}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {Array.isArray(value) ? `[${children.length}]` : `{${children.length}}`}
        </span>
      </button>
      {expanded ? (
        <div>
          {children.map(([key, entry]) => (
            <Node
              key={key}
              label={key}
              value={entry}
              depth={depth + 1}
              defaultOpen={depth < 1 && countChildren(entry) <= 12}
              filter={filter}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RawJsonViewer({
  data,
  masked = true,
  emptyLabel = "No payload was stored for this record.",
}: {
  /** Already masked and redacted server-side. */
  data: unknown;
  masked?: boolean;
  emptyLabel?: string;
}) {
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const [raw, setRaw] = useState(false);

  const text = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return "";
    }
  }, [data]);

  if (data === null || data === undefined) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure origin or denied permission): the raw
      // view below is still selectable by hand.
      setRaw(true);
    }
  };

  const entries = isContainer(data)
    ? Array.isArray(data)
      ? data.map((entry, index) => [String(index), entry] as const)
      : Object.entries(data)
    : ([["value", data]] as const);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter keys and values"
            className={`${inputClass} pl-8 text-xs`}
            aria-label="Filter raw payload"
          />
        </div>
        <Button size="sm" onClick={() => setRaw((current) => !current)}>
          {raw ? "Tree view" : "Plain text"}
        </Button>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {masked ? (
        <p className="text-xs text-muted-foreground">
          Buyer contact details are masked and any credential-shaped field is
          redacted before this payload leaves the server.
        </p>
      ) : null}

      <div className="scroll-area max-h-[32rem] overflow-auto rounded-md border border-border bg-muted/40 p-3">
        {raw ? (
          <pre className="font-mono text-[11px] whitespace-pre-wrap text-foreground">
            {text}
          </pre>
        ) : (
          entries.map(([key, entry]) => (
            <Node
              key={key}
              label={key}
              value={entry}
              depth={0}
              defaultOpen
              filter={filter.trim()}
            />
          ))
        )}
      </div>
    </div>
  );
}
