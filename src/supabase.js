import { createClient } from '@supabase/supabase-js'

// YAHAN APNI KEYS DAALNI HAI JO TUNE NOTEPAD ME SAVE KI HAI
const supabaseUrl = 'https://sanpuktgvhnwamioxvci.supabase.co'
const supabaseKey = 'sb_publishable_eDmB792NsXz-OiCxX3NQ4Q_9ncjKqL0'

export const supabase = createClient(supabaseUrl, supabaseKey)