export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      calendar_events: {
        Row: {
          all_day: boolean
          created_at: string
          description: string | null
          end_time: string | null
          event_date: string
          external_id: string | null
          id: string
          location: string | null
          project_id: string | null
          source: string
          start_time: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          all_day?: boolean
          created_at?: string
          description?: string | null
          end_time?: string | null
          event_date: string
          external_id?: string | null
          id?: string
          location?: string | null
          project_id?: string | null
          source?: string
          start_time?: string | null
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          all_day?: boolean
          created_at?: string
          description?: string | null
          end_time?: string | null
          event_date?: string
          external_id?: string | null
          id?: string
          location?: string | null
          project_id?: string | null
          source?: string
          start_time?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      canvas_assignment_preferences: {
        Row: {
          canvas_assignment_id: string
          canvas_assignment_name: string | null
          canvas_course_id: string
          created_at: string
          id: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canvas_assignment_id: string
          canvas_assignment_name?: string | null
          canvas_course_id: string
          created_at?: string
          id?: string
          state: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          canvas_assignment_id?: string
          canvas_assignment_name?: string | null
          canvas_course_id?: string
          created_at?: string
          id?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      canvas_course_links: {
        Row: {
          canvas_course_code: string | null
          canvas_course_id: string
          canvas_course_name: string | null
          created_at: string
          id: string
          project_id: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          canvas_course_code?: string | null
          canvas_course_id: string
          canvas_course_name?: string | null
          created_at?: string
          id?: string
          project_id?: string | null
          state: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          canvas_course_code?: string | null
          canvas_course_id?: string
          canvas_course_name?: string | null
          created_at?: string
          id?: string
          project_id?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "canvas_course_links_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      google_calendar_connections: {
        Row: {
          access_token_ciphertext: string | null
          access_token_expires_at: string | null
          connected_at: string
          created_at: string
          google_account_email: string | null
          id: string
          refresh_token_ciphertext: string | null
          selected_calendar_id: string | null
          selected_calendar_name: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          google_account_email?: string | null
          id?: string
          refresh_token_ciphertext?: string | null
          selected_calendar_id?: string | null
          selected_calendar_name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          google_account_email?: string | null
          id?: string
          refresh_token_ciphertext?: string | null
          selected_calendar_id?: string | null
          selected_calendar_name?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      google_calendar_item_links: {
        Row: {
          calendar_event_id: string | null
          content_hash: string
          created_at: string
          google_calendar_id: string
          google_event_id: string
          id: string
          item_type: string
          last_synced_at: string
          task_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          calendar_event_id?: string | null
          content_hash: string
          created_at?: string
          google_calendar_id: string
          google_event_id: string
          id?: string
          item_type: string
          last_synced_at?: string
          task_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          calendar_event_id?: string | null
          content_hash?: string
          created_at?: string
          google_calendar_id?: string
          google_event_id?: string
          id?: string
          item_type?: string
          last_synced_at?: string
          task_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_calendar_item_links_event_owner_fkey"
            columns: ["calendar_event_id", "user_id"]
            isOneToOne: false
            referencedRelation: "calendar_events"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "google_calendar_item_links_task_owner_fkey"
            columns: ["task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      inbox_items: {
        Row: {
          content: string | null
          created_at: string
          external_id: string | null
          id: string
          kind: string
          project_id: string | null
          source: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          kind: string
          project_id?: string | null
          source?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          external_id?: string | null
          id?: string
          kind?: string
          project_id?: string | null
          source?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbox_items_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      projects: {
        Row: {
          area: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          progress: number
          source: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          area?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          progress?: number
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          area?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          progress?: number
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          description: string | null
          due_date: string | null
          external_id: string | null
          id: string
          priority: string
          project_id: string | null
          source: string
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          priority?: string
          project_id?: string | null
          source?: string
          status?: string
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          priority?: string
          project_id?: string | null
          source?: string
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_owner_fkey"
            columns: ["project_id", "user_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_project_from_canvas_course: {
        Args: {
          p_area?: string
          p_canvas_course_code?: string
          p_canvas_course_id: string
          p_canvas_course_name?: string
          p_description?: string
          p_name: string
          p_status?: string
        }
        Returns: string
      }
      get_google_calendar_credentials: {
        Args: never
        Returns: {
          access_token_ciphertext: string
          access_token_expires_at: string
          refresh_token_ciphertext: string
        }[]
      }
      set_canvas_assignment_preference: {
        Args: {
          p_canvas_assignment_id: string
          p_canvas_assignment_name?: string
          p_canvas_course_id: string
          p_state: string
        }
        Returns: number
      }
      sync_canvas_course_tasks: {
        Args: { p_assignments: Json; p_canvas_course_id: string }
        Returns: {
          assignment_id: string
          outcome: string
        }[]
      }
      sync_google_calendar_events: {
        Args: { p_calendar_id: string; p_events: Json }
        Returns: {
          event_id: string
          outcome: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
