import { Metadata } from 'next';

export const metadata: Metadata = { title: 'My Timesheets' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
