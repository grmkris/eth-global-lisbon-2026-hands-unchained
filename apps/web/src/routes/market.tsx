import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { PageHeader } from "#/components/page-header";
import { StatusBadge, type StatusTone } from "#/components/status-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import {
	type MarketLedgerRow,
	marketLedgerQuery,
	marketSessionQuery,
	marketStatsQuery,
} from "#/market/market-api";

export const Route = createFileRoute("/market")({ component: MarketPage });

const statusTone: Record<string, StatusTone> = {
	open: "info",
	closed: "neutral",
	graded: "info",
	paid: "success",
	rejected: "danger",
	anchored: "success",
};

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<Card>
			<CardContent className="flex flex-col gap-1 py-4">
				<span className="text-xs text-muted-foreground">{label}</span>
				<span className="font-mono text-2xl tabular-nums">{value}</span>
			</CardContent>
		</Card>
	);
}

function GradeCell({ row }: { row: MarketLedgerRow }) {
	if (row.grade === null)
		return <span className="text-muted-foreground">—</span>;
	return (
		<span className="flex items-center gap-2" title={row.grade.reason}>
			<StatusBadge tone={row.grade.pass ? "success" : "danger"}>
				{row.grade.pass ? "pass" : "fail"} {row.grade.score}
			</StatusBadge>
			<span className="font-mono text-xs text-muted-foreground">
				{row.grade.provider}
			</span>
		</span>
	);
}

function MarketPage() {
	const session = useQuery(marketSessionQuery);
	const stats = useQuery(marketStatsQuery);
	const ledger = useQuery(marketLedgerQuery);

	if (session.data?.marketMode === false)
		return (
			<div>
				<PageHeader
					title="Market"
					description="Verified humans teach robots; graded work gets paid"
				/>
				<Empty className="mt-6 border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Coins />
						</EmptyMedia>
						<EmptyTitle>The market is not enabled on this hub</EmptyTitle>
						<EmptyDescription>
							Set MARKET_MODE=1 to gate driving on World ID, grade attempts on
							0G Compute and settle per episode in HBAR.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);

	const s = stats.data;
	const rows = ledger.data ?? [];

	return (
		<div>
			<PageHeader
				title="Market"
				description="Verified humans teach robots; every episode is graded by a TEE referee and settled in HBAR"
				actions={
					<Button asChild variant="outline">
						<Link to="/lobby">Find a rig to drive</Link>
					</Button>
				}
			/>

			<div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
				<Stat label="verified humans" value={s?.operators ?? "…"} />
				<Stat label="attempts" value={s?.attempts ?? "…"} />
				<Stat
					label="pass rate"
					value={
						s && s.graded > 0
							? `${Math.round((s.passed / s.graded) * 100)}%`
							: "—"
					}
				/>
				<Stat label="HBAR paid" value={s?.paidHbar.toFixed(1) ?? "…"} />
				<Stat label="bonds locked" value={s?.bondsLocked ?? "…"} />
			</div>

			{rows.length === 0 ? (
				<Empty className="mt-6 border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Coins />
						</EmptyMedia>
						<EmptyTitle>No attempts yet</EmptyTitle>
						<EmptyDescription>
							Take a rig in the lobby, run a task attempt, and it lands here —
							graded, paid and anchored.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<Table className="mt-6">
					<TableHeader>
						<TableRow>
							<TableHead>when</TableHead>
							<TableHead>rig · task</TableHead>
							<TableHead>operator</TableHead>
							<TableHead>claimed</TableHead>
							<TableHead>grade</TableHead>
							<TableHead className="text-right">payout</TableHead>
							<TableHead>status</TableHead>
							<TableHead>evidence</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.id}>
								<TableCell className="whitespace-nowrap font-mono text-xs">
									{new Date(row.openedAt).toLocaleTimeString()}
								</TableCell>
								<TableCell>
									<span className="font-mono">{row.rig}</span>
									{row.taskTitle && (
										<span className="block max-w-48 truncate text-xs text-muted-foreground">
											{row.taskTitle}
										</span>
									)}
								</TableCell>
								<TableCell className="font-mono text-xs">
									{row.operator.nullifier ?? "unverified"}
									{row.operator.evmAddress && (
										<a
											className="block text-muted-foreground underline"
											href={`https://hashscan.io/testnet/account/${row.operator.evmAddress}`}
											target="_blank"
											rel="noreferrer"
										>
											{row.operator.evmAddress.slice(0, 10)}…
										</a>
									)}
								</TableCell>
								<TableCell>
									{row.claimed === null ? (
										<StatusBadge tone="info">driving…</StatusBadge>
									) : (
										<StatusBadge
											tone={row.claimed === "success" ? "neutral" : "warn"}
										>
											{row.claimed}
										</StatusBadge>
									)}
								</TableCell>
								<TableCell>
									<GradeCell row={row} />
								</TableCell>
								<TableCell className="text-right font-mono text-xs tabular-nums">
									{row.payment?.txId ? (
										<a
											className="underline"
											href={`https://hashscan.io/testnet/transaction/${row.payment.txId}`}
											target="_blank"
											rel="noreferrer"
										>
											{row.payment.amountHbar} ℏ
										</a>
									) : row.payment?.kind === "none" ? (
										"0 ℏ"
									) : (
										"—"
									)}
								</TableCell>
								<TableCell>
									<StatusBadge tone={statusTone[row.status] ?? "neutral"}>
										{row.status}
									</StatusBadge>
								</TableCell>
								<TableCell>
									{row.hasEvidence ? (
										<img
											src={`/api/market/evidence/${encodeURIComponent(row.id)}`}
											alt="final frame"
											className="h-10 w-16 rounded object-cover"
											loading="lazy"
										/>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
