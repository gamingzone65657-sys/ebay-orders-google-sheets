"use client";

import { useState } from "react";

import { FeedbackBanner } from "@/components/FeedbackBanner";
import { Button } from "@/components/ui/Button";
import { Badge, inputClass } from "@/components/ui/primitives";
import { useApiAction } from "@/components/useApiAction";

export interface SavedConfigSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  mappingCount: number;
  spreadsheetName: string | null;
  updatedAt: string;
}

export function SavedConfigurations({
  configurations,
  canSave,
}: {
  configurations: SavedConfigSummary[];
  canSave: boolean;
}) {
  const { run, pending, feedback } = useApiAction();
  const [name, setName] = useState("");

  return (
    <div className="space-y-4">
      <FeedbackBanner feedback={feedback} />

      {configurations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No saved configurations yet. Save the current mapping set to reuse it
          on another sheet later.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {configurations.map((config) => (
            <li
              key={config.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {config.name}
                  </p>
                  {config.isDefault ? (
                    <Badge tone="info">Default</Badge>
                  ) : null}
                </div>
                {config.description ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {config.description}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {config.mappingCount} mapping
                  {config.mappingCount === 1 ? "" : "s"}
                  {config.spreadsheetName
                    ? ` · built for ${config.spreadsheetName}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={pending !== null}
                  onClick={() =>
                    run(
                      `apply-${config.id}`,
                      {
                        url: `/api/saved-configurations/${config.id}`,
                        body: { action: "apply" },
                      },
                      {
                        successMessage: `Applied "${config.name}" to the active sheet.`,
                      },
                    )
                  }
                >
                  {pending === `apply-${config.id}` ? "Applying…" : "Apply"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending !== null}
                  onClick={() =>
                    run(
                      `delete-${config.id}`,
                      {
                        url: `/api/saved-configurations/${config.id}`,
                        method: "DELETE",
                      },
                      { successMessage: `Deleted "${config.name}".` },
                    )
                  }
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="saved-config-name"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            Save current mappings as
          </label>
          <input
            id="saved-config-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Accounting export"
            className={inputClass}
            disabled={!canSave}
          />
        </div>
        <Button
          variant="primary"
          disabled={!canSave || !name.trim() || pending !== null}
          onClick={async () => {
            const result = await run(
              "save-config",
              {
                url: "/api/saved-configurations",
                body: { name: name.trim() },
              },
              { successMessage: `Saved "${name.trim()}".` },
            );
            if (result.ok) setName("");
          }}
        >
          {pending === "save-config" ? "Saving…" : "Save configuration"}
        </Button>
      </div>
      {!canSave ? (
        <p className="text-xs text-muted-foreground">
          Select a destination spreadsheet before saving a configuration.
        </p>
      ) : null}
    </div>
  );
}
