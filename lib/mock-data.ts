// Static placeholder content for the Home screen. Replaced by real sources in later phases.

export type MockDate = {
  weekday: string;
  date: string;
  short: string;
  week: number;
};

export type UpcomingEvent = {
  id: string;
  time: string;
  title: string;
  location: string;
};

export type Task = {
  id: string;
  title: string;
  area: string;
  due: "Hoy" | "Mañana";
};

export const today: MockDate = {
  weekday: "Lunes",
  date: "5 de octubre de 2026",
  short: "05.10.26",
  week: 41,
};

export const activeProjectCount = 1;

export const upcomingEvents: UpcomingEvent[] = [
  { id: "e1", time: "10:00", title: "Taller de Proyectos", location: "Aula 3.2 · Arquitectura" },
  { id: "e2", time: "14:00", title: "Imprimir A1", location: "Copycenter" },
  { id: "e3", time: "18:00", title: "Observación astronómica", location: "Roque de los Muchachos" },
];

export const tasks: Task[] = [
  { id: "t1", title: "Revisar planos del taller", area: "Arquitectura", due: "Hoy" },
  { id: "t2", title: "Comprar cartón pluma", area: "Arquitectura", due: "Hoy" },
  { id: "t3", title: "Leer artículo sobre exoplanetas", area: "Astronomía", due: "Mañana" },
  { id: "t4", title: "Terminar módulo de autenticación", area: "Programación", due: "Mañana" },
];
