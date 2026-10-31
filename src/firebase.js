import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseConfigured = Object.values(config).every(Boolean);

let auth = null;
if (firebaseConfigured) {
  const app = getApps()[0] || initializeApp(config);
  auth = getAuth(app);
}

export async function signInWithGoogle() {
  if (!auth) {
    throw new Error("Firebaseの設定がありません。");
  }

  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return {
    idToken: await result.user.getIdToken(),
    displayName: result.user.displayName || "",
    email: result.user.email || ""
  };
}

export async function signOutFromFirebase() {
  if (auth) await signOut(auth);
}
