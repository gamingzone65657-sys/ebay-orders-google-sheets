import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-1 text-xl font-semibold text-foreground">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          That route does not exist in this workspace.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex h-9 items-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
