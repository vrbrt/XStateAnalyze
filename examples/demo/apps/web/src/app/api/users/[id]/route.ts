import { NextResponse } from 'next/server';
import { fetchUser, updateUser } from '@demo/api-client';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await fetchUser(params.id);
  return NextResponse.json(user);
}

export async function PUT(req: Request) {
  const body = await req.json();
  const user = await updateUser(body);
  return NextResponse.json(user);
}
