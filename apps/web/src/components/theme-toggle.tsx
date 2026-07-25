import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";

export function ThemeToggle() {
	// resolved after mount — SSR always renders dark, the head script may flip it pre-paint
	const [isDark, setIsDark] = useState<boolean | null>(null);

	useEffect(() => {
		setIsDark(document.documentElement.classList.contains("dark"));
	}, []);

	const toggle = () => {
		const next = !(isDark ?? true);
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem("theme", next ? "dark" : "light");
		} catch {}
		setIsDark(next);
	};

	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={toggle}
			title={isDark === false ? "Switch to dark" : "Switch to light"}
		>
			{isDark === false ? <Sun /> : <Moon />}
		</Button>
	);
}
