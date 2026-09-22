import clsx from "clsx";

import type { ActionFeedback } from "@/components/useApiAction";

export function FeedbackBanner({
  feedback,
  className,
}: {
  feedback: ActionFeedback | null;
  className?: string;
}) {
  if (!feedback) return null;
  return (
    <div
      role="status"
      className={clsx(
        "rounded-md border px-3 py-2 text-sm",
        feedback.tone === "success"
          ? "border-success-border bg-success-bg text-success"
          : "border-danger-border bg-danger-bg text-danger",
        className,
      )}
    >
      {feedback.message}
    </div>
  );
}
