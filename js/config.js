/* ==========================================================================
   CONFIGURACIÓN INICIAL DE C4LEB BARBER
   Edita este archivo para cambiar los datos por defecto, el PIN inicial,
   los servicios iniciales o los horarios base.
   ========================================================================== */

window.SALON_CONFIG = {
  // --------------------------------------------------------------------------
  // CONEXIÓN A SUPABASE (Base de datos en la nube)
  // 1. Crea tu proyecto gratis en https://supabase.com
  // 2. Ejecuta el archivo supabase/schema.sql en "SQL Editor"
  // 3. Pega aquí tu "Project URL" y "anon public key" (Project Settings -> API)
  // Mientras estén vacíos (""), la web funcionará en Modo Local (localStorage).
  // --------------------------------------------------------------------------
  supabaseUrl: "https://lwbxyhysuogbqnmziewv.supabase.co",
  supabaseAnonKey: "sb_publishable_t3QdVczBRZPRCUPVccRzgg_LodKa4hp",

  // Información general del negocio
  businessName: "C4LEB BARBER",
  stylistName: "Caleb",
  businessTagline:
    "Barbería independiente enfocada en fades limpios, cortes precisos y estilo urbano. Revisa nuestros horarios disponibles y reserva tu turno sin esperas.",
  instagramHandle: "@c4leb.barber",
  instagramUrl: "https://www.instagram.com/c4leb.barber/",
  whatsappNumber: "56912345678", // Cámbialo por el número real (código de país + número, sin +)
  currencySymbol: "$",

  // PIN por defecto para entrar al "Panel Barbero"
  adminPin: "1234",

  // Horario laboral por defecto
  schedule: {
    openTime: "10:00",
    closeTime: "20:00",
    breakStart: "14:00", // Opcional: deja "" si no hay cierre de almuerzo
    breakEnd: "15:00",
    slotStepMinutes: 15, // Intervalos de 15 min para acomodar bien turnos de 30, 45 y 60 min
    workingDays: [2, 3, 4, 5, 6] // 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
  },

  // Catálogo inicial de servicios (precios en Pesos Chilenos - CLP)
  defaultServices: [
    {
      id: "srv-corte-clasico",
      name: "Corte Clásico",
      category: "Cortes",
      duration: 30,
      price: 8000,
      description: "Corte tradicional o limpio a tijera y máquina con terminación prolija.",
      active: true
    },
    {
      id: "srv-corte-fade",
      name: "Corte Fade",
      category: "Cortes",
      duration: 45,
      price: 10000,
      description: "Degradado limpio (low, mid o high fade) con perfilado y styling final.",
      active: true
    },
    {
      id: "srv-corte-barba",
      name: "Corte más Barba",
      category: "Combos",
      duration: 60,
      price: 15000,
      description: "Corte a elección más perfilado, rebaje y delineado completo de barba.",
      active: true
    }
  ]
};
