import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: "AIzaSyBW_PE2RiIs-4_tAoOtKdQLXijh9-WNv7Q",
    authDomain: "lore-platform-hu247.firebaseapp.com",
    projectId: "lore-platform-hu247",
    storageBucket: "lore-platform-hu247.firebasestorage.app",
    messagingSenderId: "805876457264",
    appId: "1:805876457264:web:8fbed6dd7209a3677132f5"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };