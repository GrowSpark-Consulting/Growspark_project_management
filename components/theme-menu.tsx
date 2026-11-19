'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, Check } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { applyThemeChoice, readThemeChoice, resolveTheme, type ThemeChoice } from '@/lib/theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light / Dark / System items for a user dropdown menu. */
export function ThemeMenuItems() {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoice(readThemeChoice());
    // Follow the operating system while "System" is selected
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readThemeChoice() === 'system') document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    };
    media?.addEventListener?.('change', onChange);
    return () => media?.removeEventListener?.('change', onChange);
  }, []);

  return (
    <>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Theme</DropdownMenuLabel>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <DropdownMenuItem
          key={value}
          onSelect={(e) => { e.preventDefault(); applyThemeChoice(value); setChoice(value); }}
          className="flex items-center gap-2 cursor-pointer"
        >
          <Icon className="h-4 w-4" />
          <span className="flex-1">{label}</span>
          {choice === value && <Check className="h-4 w-4 text-primary" aria-label="Selected" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
