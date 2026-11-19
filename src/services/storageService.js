import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase/config.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export async function uploadAttachment(folder, uid, file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 5 MB upload limit.');
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Only JPG, PNG, WebP images or PDF documents are supported.');
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectPath = `${folder}/${uid}/${Date.now()}_${safeName}`;
  const storageRef = ref(storage, objectPath);
  const snapshot = await uploadBytes(storageRef, file, { contentType: file.type });
  const downloadUrl = await getDownloadURL(snapshot.ref);
  return { objectPath, downloadUrl };
}
