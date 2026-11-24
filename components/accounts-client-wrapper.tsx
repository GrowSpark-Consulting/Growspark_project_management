'use client';

import { useRouter } from 'next/navigation';
import { AccountList } from '@/components/account-list';
import { Account } from '@/lib/account-service';
import { UserWithRoles } from '@/lib/rbac';

interface AccountsClientWrapperProps {
  initialAccounts: Account[];
  userProfile: UserWithRoles;
  isAdminLevel: boolean;
}

export function AccountsClientWrapper({ 
  initialAccounts, 
  userProfile, 
  isAdminLevel 
}: AccountsClientWrapperProps) {
  const router = useRouter();
  // The list comes from the server page, so a refresh brings the new account in
  const accounts = initialAccounts;

  const handleAccountCreated = () => {
    // Reload the page's data in place (no full page reload)
    router.refresh();
  };

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
          <div className="space-y-3">
            <h1 className="text-4xl font-bold text-foreground">Accounts</h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              {isAdminLevel 
                ? "Manage client accounts and their associated projects"
                : "View accounts you have access to and their associated projects"
              }
            </p>
          </div>
        </div>
      </div>

      <AccountList 
        accounts={accounts} 
        userProfile={userProfile} 
        onAccountCreated={handleAccountCreated}
      />
    </div>
  );
}
