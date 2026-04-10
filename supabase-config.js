
const SUPABASE_URL     = 'https://dzcdxizkskmtuvxebhhl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_secret_ndxshYlMhdruEvlSMsX0QQ_csm5BiG6';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Código secreto para registrarse como administrador
// Cambialo antes de publicar
const ADMIN_CODE = 'PROFE2025';

// Cursos de los que realizan el proyecto
const STUDENT_COURSES = ['5°1°', '5°2°', '5°3°'];

// Cursos de la escuela que hay que visitar (19 en total)
const TARGET_COURSES = [
  '1°1°', '1°2°', '1°3°', '1°4°', '1°5°', '1°6°',
  '2°1°', '2°2°', '2°3°', '2°4°', '2°5°',
  '3°1°', '3°2°', '3°3°', '3°4°',
  '4°1°', '4°2°', '4°3°', '4°4°'
];
