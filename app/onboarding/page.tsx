import { redirect } from 'next/navigation';

// First-run setup is now the company registration page (workspace + manager in one step).
export default function OnboardingPage() {
  redirect('/signup');
}
