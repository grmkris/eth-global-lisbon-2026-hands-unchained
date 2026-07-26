import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { connect, currentAddress, walletAvailable } from "#/market/zg-wallet";

/**
 * The injected wallet's current account, in ONE place.
 *
 * It used to be `useState` inside SlotGate, which was fine while the gate was
 * the only thing that cared. It is not: the nav shows the connected address on
 * every page — including after the gate is cleared and unmounted — so the two
 * would otherwise hold separate copies of the same fact and drift apart the
 * moment someone switches accounts in MetaMask.
 *
 * `eth_accounts` (inside `currentAddress`) reports an ALREADY-authorised
 * account and never prompts, so a page load costs the operator no popup.
 * Deliberately NOT localStorage: a stale address there would outlive the
 * wallet's authorisation and start lying rather than merely forgetting.
 */
export const walletAddressQuery = {
	queryKey: ["wallet", "address"] as const,
	queryFn: () => currentAddress(),
	staleTime: Number.POSITIVE_INFINITY,
	retry: false,
};

export interface WalletState {
	/** authorised account, null when no wallet or not connected yet */
	address: `0x${string}` | null;
	available: boolean;
	connecting: boolean;
	connect: (chainKey?: string) => void;
}

export function useWallet(): WalletState {
	const queryClient = useQueryClient();
	const address = useQuery(walletAddressQuery);

	// MetaMask's account switcher fires this; without it the app keeps showing
	// the old address until a reload, which is the exact drift the gate warns
	// about ("you proved World ID on a different account").
	useEffect(() => {
		const eth = (
			globalThis as {
				ethereum?: {
					on?: (e: string, cb: () => void) => void;
					removeListener?: (e: string, cb: () => void) => void;
				};
			}
		).ethereum;
		if (!eth?.on) return;
		const refresh = () =>
			void queryClient.invalidateQueries({ queryKey: ["wallet", "address"] });
		eth.on("accountsChanged", refresh);
		return () => eth.removeListener?.("accountsChanged", refresh);
	}, [queryClient]);

	const doConnect = useMutation({
		mutationFn: (chainKey?: string) => connect(chainKey ?? "0g"),
		onSuccess: (account) =>
			queryClient.setQueryData(walletAddressQuery.queryKey, account),
		onError: (e) =>
			toast.error(e instanceof Error ? e.message : "could not connect"),
	});

	return {
		address: address.data ?? null,
		available: walletAvailable(),
		connecting: doConnect.isPending,
		connect: (chainKey) => doConnect.mutate(chainKey),
	};
}
