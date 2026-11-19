'use client';

import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, MessageCircle, CheckCircle2 } from 'lucide-react';

interface InviteSharePanelProps {
  acceptUrl: string;
  whatsappUrl?: string | null;
  emailSent?: boolean;
  recipient?: string;
  validDays?: number;
}

/** Shows the invite link after an invitation is created: copy it, or share it on WhatsApp (free wa.me link). */
export function InviteSharePanel({ acceptUrl, whatsappUrl, emailSent, recipient, validDays = 7 }: InviteSharePanelProps) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(acceptUrl);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy. Select the link and copy it manually.');
    }
  };
  return (
    <div className="space-y-3 rounded-md border border-green-200 bg-green-50 p-3">
      <p className="text-sm font-medium text-green-800 flex items-center gap-1">
        <CheckCircle2 className="h-4 w-4" />
        Invitation created{recipient ? ` for ${recipient}` : ''}.
        {emailSent === true && ' Email sent.'}
        {emailSent === false && ' No email was sent: share the link below.'}
      </p>
      <Input readOnly value={acceptUrl} onFocus={(e) => e.currentTarget.select()} className="bg-white text-xs" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}><Copy className="h-4 w-4 mr-1" />Copy link</Button>
        {whatsappUrl && (
          <Button type="button" size="sm" className="bg-green-600 hover:bg-green-700 text-white" asChild>
            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4 mr-1" />Share on WhatsApp</a>
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-600">The link is valid for {validDays} day{validDays === 1 ? '' : 's'} and works once.</p>
    </div>
  );
}
