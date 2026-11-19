'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  FolderOpen,
  User,
  LogOut,
  Building2,
  Menu,
  X,
  ClipboardCheck,
  Bell,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SidebarBrand } from '@/components/brand-chip';
import { sidebarItemClass } from '@/components/sidebar/sidebar-item';

interface ClientPortalSidebarProps {
  userName: string;
  userEmail: string;
  accountName: string;
}

const navItems = [
  { name: 'Dashboard', href: '/client-portal', icon: LayoutDashboard, exactMatch: true },
  { name: 'Projects', href: '/client-portal/projects', icon: FolderOpen, exactMatch: false },
  { name: 'Approvals', href: '/client-portal/approvals', icon: ClipboardCheck, exactMatch: true },
  { name: 'Notifications', href: '/client-portal/notifications', icon: Bell, exactMatch: true },
  { name: 'Profile', href: '/client-portal/profile', icon: User, exactMatch: true },
];

export default function ClientPortalSidebar({
  userName,
  userEmail,
  accountName,
}: ClientPortalSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
      router.push('/login');
      router.refresh();
    } catch {
      // Sign-out errors are non-critical
    } finally {
      setIsSigningOut(false);
    }
  }

  function getInitials(name: string) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  function isActive(href: string, exactMatch: boolean) {
    if (exactMatch) {
      return pathname === href;
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[var(--sidebar)] text-[var(--on-sidebar)]">
      {/* Product header + portal label */}
      <div className="px-5 pt-4 pb-3">
        <Link href="/client-portal" className="flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]">
          <SidebarBrand />
        </Link>
        <p className="mt-2 text-xs font-medium uppercase tracking-[0.04em] text-[var(--on-sidebar-muted)]">Client portal</p>
      </div>

      {/* Account Name */}
      <div className="mx-3 mb-2 rounded-md bg-[var(--sidebar-active)] px-3 py-2">
        <div className="flex items-center gap-2 text-[var(--on-sidebar)]">
          <Building2 className="h-4 w-4 flex-shrink-0 opacity-85" strokeWidth={1.75} />
          <span className="text-[13px] font-medium truncate">{accountName}</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-0.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href, item.exactMatch);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className={sidebarItemClass(active)}
            >
              <Icon className="h-[18px] w-[18px] flex-shrink-0 opacity-85" strokeWidth={1.75} />
              <span className="truncate">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* User Profile + Sign Out */}
      <div className="border-t border-[var(--sidebar-active)] p-3">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-7 w-7 rounded-full bg-[var(--sidebar-active)] text-[var(--on-sidebar)] flex items-center justify-center text-xs font-semibold flex-shrink-0">
            {getInitials(userName)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--on-sidebar)] truncate">
              {userName}
            </p>
            <p className="text-xs text-[var(--on-sidebar-muted)] truncate">
              {userEmail}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          disabled={isSigningOut}
          className="w-full justify-start gap-2 border-transparent bg-transparent text-[var(--on-sidebar)] hover:bg-[var(--sidebar-active)] hover:text-[var(--on-sidebar)]"
        >
          <LogOut className="h-4 w-4" />
          {isSigningOut ? 'Signing out...' : 'Sign out'}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar -- always visible */}
      <aside className="hidden lg:flex w-60 flex-shrink-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile toggle button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-3 left-3 z-50 bg-background/80 backdrop-blur-sm border shadow-sm"
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </Button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile sidebar drawer */}
      <aside
        className={cn(
          'lg:hidden fixed inset-y-0 left-0 z-40 w-60 transform transition-transform duration-200 ease-in-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
