"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { inputClass, selectClass } from "@/components/ui/primitives";
import { ORDER_STATUSES, ORDER_SYNC_STATE } from "@/lib/constants";

const SYNC_STATES = Object.values(ORDER_SYNC_STATE);

export interface OrdersFilterValues {
  q: string;
  sku: string;
  status: string;
  syncState: string;
  marketplaceId: string;
  from: string;
  to: string;
}

const EMPTY: OrdersFilterValues = {
  q: "",
  sku: "",
  status: "",
  syncState: "",
  marketplaceId: "",
  from: "",
  to: "",
};

export function OrdersFilters({
  initial,
  marketplaces,
}: {
  initial: OrdersFilterValues;
  /** Marketplaces actually present in this workspace's orders. */
  marketplaces: string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState(initial);

  // Keep the inputs in step when the URL changes (back/forward, reset).
  useEffect(() => {
    setFilters(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  const apply = (next: OrdersFilterValues) => {
    const params = new URLSearchParams();
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.sku.trim()) params.set("sku", next.sku.trim());
    if (next.status) params.set("status", next.status);
    if (next.syncState) params.set("syncState", next.syncState);
    if (next.marketplaceId) params.set("marketplaceId", next.marketplaceId);
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    router.push(params.toString() ? `/orders?${params}` : "/orders");
  };

  const hasFilters = Object.values(filters).some((value) => value !== "");

  const applyNow = (patch: Partial<OrdersFilterValues>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    apply(next);
  };

  return (
    <form
      className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        apply(filters);
      }}
    >
      <div className="min-w-[220px] flex-1">
        <label
          htmlFor="orders-search"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          Search
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="orders-search"
            type="search"
            value={filters.q}
            placeholder="Order ID, buyer, item title, or tracking"
            onChange={(event) =>
              setFilters({ ...filters, q: event.target.value })
            }
            className={`${inputClass} pl-8`}
          />
        </div>
      </div>

      <div className="w-40">
        <label
          htmlFor="orders-sku"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          SKU
        </label>
        <input
          id="orders-sku"
          type="search"
          value={filters.sku}
          placeholder="Filter by SKU"
          onChange={(event) =>
            setFilters({ ...filters, sku: event.target.value })
          }
          className={inputClass}
        />
      </div>

      <div className="w-36">
        <label
          htmlFor="orders-status"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          Order status
        </label>
        <select
          id="orders-status"
          value={filters.status}
          onChange={(event) => applyNow({ status: event.target.value })}
          className={selectClass}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.charAt(0) + status.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      <div className="w-36">
        <label
          htmlFor="orders-marketplace"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          Marketplace
        </label>
        <select
          id="orders-marketplace"
          value={filters.marketplaceId}
          onChange={(event) => applyNow({ marketplaceId: event.target.value })}
          className={selectClass}
        >
          <option value="">All marketplaces</option>
          {marketplaces.map((marketplace) => (
            <option key={marketplace} value={marketplace}>
              {marketplace}
            </option>
          ))}
        </select>
      </div>

      <div className="w-36">
        <label
          htmlFor="orders-sync"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          Sync state
        </label>
        <select
          id="orders-sync"
          value={filters.syncState}
          onChange={(event) => applyNow({ syncState: event.target.value })}
          className={selectClass}
        >
          <option value="">Any state</option>
          {SYNC_STATES.map((state) => (
            <option key={state} value={state}>
              {state.charAt(0) + state.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      <div className="w-[9.5rem]">
        <label
          htmlFor="orders-from"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          From
        </label>
        <input
          id="orders-from"
          type="date"
          value={filters.from}
          onChange={(event) => applyNow({ from: event.target.value })}
          className={inputClass}
        />
      </div>

      <div className="w-[9.5rem]">
        <label
          htmlFor="orders-to"
          className="mb-1.5 block text-xs font-medium text-foreground"
        >
          To
        </label>
        <input
          id="orders-to"
          type="date"
          value={filters.to}
          onChange={(event) => applyNow({ to: event.target.value })}
          className={inputClass}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary">
          Apply
        </Button>
        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFilters(EMPTY);
              apply(EMPTY);
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}
