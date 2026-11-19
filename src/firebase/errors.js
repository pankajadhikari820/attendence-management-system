import { auth } from './config.js';

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

export function handleFirestoreError(error, operationType, path) {
  const user = auth.currentUser;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path: path || null,
    authInfo: {
      userId: user ? user.uid : null,
      email: user ? user.email : null,
      emailVerified: user ? user.emailVerified : null,
      isAnonymous: user ? user.isAnonymous : null,
      tenantId: user ? user.tenantId : null,
      providerInfo:
        user && Array.isArray(user.providerData)
          ? user.providerData.map((p) => ({
              providerId: p.providerId,
              email: p.email,
            }))
          : [],
    },
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  const wrapped = new Error(errInfo.error);
  wrapped.firestoreInfo = errInfo;
  wrapped.code = error && error.code ? error.code : 'firestore/error';
  throw wrapped;
}
