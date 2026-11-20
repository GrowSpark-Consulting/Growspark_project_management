import { NextRequest, NextResponse } from 'next/server'
import { slugProblem } from '@/lib/registration-rules'

// GET /api/register/slug?slug= - is this workspace URL acceptable? (one workspace per installation:
// any valid, non-reserved URL is free until the workspace is registered)
export async function GET(request: NextRequest) {
  const slug = (new URL(request.url).searchParams.get('slug') || '').trim()
  const problem = slugProblem(slug)
  return NextResponse.json({ data: { slug, available: !problem, problem } })
}
