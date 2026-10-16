import { cn } from "@/lib/utils";

// shadcn 標準骨架：animate-pulse 圓角灰底 div（#26）
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
