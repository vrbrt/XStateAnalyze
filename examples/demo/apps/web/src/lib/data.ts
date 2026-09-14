// Packages below are intentionally NOT installed: exercises the import-map fallback resolution.
import { PrismaClient } from '@prisma/client';
import { gql, useQuery } from '@apollo/client';
import { trpc } from '@/lib/trpc';
import { io } from 'socket.io-client';
import ky from 'ky';

const prisma = new PrismaClient();

export const GET_PROFILE = gql`
  query GetProfile($id: ID!) { user(id: $id) { id name } }
`;

export async function getUsersFromDb() {
  return prisma.user.findMany({ where: { active: true } });
}

export function useProfile(id: string) {
  return useQuery(GET_PROFILE, { variables: { id } });
}

export function useSettings() {
  return trpc.settings.get.useQuery();
}

export function connectSocket() {
  const socket = io('wss://rt.example.com');
  socket.emit('hello');
  return socket;
}

export const kyApi = ky.create({ prefixUrl: 'https://ky.example.com' });
export async function ping() {
  return kyApi.get('health').json();
}
