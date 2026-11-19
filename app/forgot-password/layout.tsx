import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Forgot Password',
  description: 'Reset your Project Management account password.',
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
